import fs from 'node:fs';
import path from 'node:path';
import { MAX_SOURCE_SECONDS, MAX_UPLOAD_BYTES, STATUS, aiConfigured, youtubeConfigured } from '../config.js';
import {
  addChat,
  addMemory,
  db,
  getChannel,
  getJob,
  getPreferences,
  getProject,
  getShort,
  listJobs,
  listShorts,
  logJob,
  notify,
  now,
  projectRow,
  setPreference,
  uid,
} from '../db.js';
import { ensureProjectDirs } from './pipeline.js';
import { probe } from './ffmpeg.js';
import { enqueueJob, cancelJob } from './queue.js';
import { aiConfigured as geminiReady, parseCommand } from './gemini.js';
import { fetchOwnedCaptions, fetchOwnedVideo, getAccessToken } from './youtube.js';

const URL_RE = /(https?:\/\/[^\s<>"']+)/i;

export function parseYouTubeId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return parsed.pathname.slice(1).split('/')[0] || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (parsed.searchParams.get('v')) return parsed.searchParams.get('v');
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) return parts[1] || null;
    }
    return null;
  } catch {
    return null;
  }
}

const isDirectMediaUrl = (url) => /\.(mp4|mov|mkv|webm|m4v|avi)(\?|$)/i.test(url);

function sanitizeTitle(name) {
  return String(name || 'Untitled project')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'Untitled project';
}

function insertProject(fields) {
  const id = uid('pr');
  const ts = now();
  db.prepare(
    `INSERT INTO projects (id, title, source_type, source_url, source_path, source_attestation, source_note, status, stage, progress, language, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    fields.title,
    fields.sourceType,
    fields.sourceUrl || null,
    fields.sourcePath || null,
    fields.attestation ? 1 : 0,
    fields.note || null,
    fields.status || 'created',
    fields.stage || 'created',
    0,
    fields.language || getPreferences().language || 'en',
    ts,
    ts,
  );
  return getProject(id);
}

/**
 * Ingest an uploaded file. The user must confirm they own the material.
 */
export async function createProjectFromUpload({ filePath, originalName, title, attestation }) {
  if (!attestation) throw new Error('You must confirm you own this video or have permission to edit it.');
  const info = await probe(filePath);
  if (info.duration > MAX_SOURCE_SECONDS) throw new Error('This source exceeds the configured maximum duration.');
  const id = uid('pr');
  const paths = ensureProjectDirs(id);
  const ext = (path.extname(originalName || '') || '.mp4').toLowerCase();
  const dest = path.join(paths.dir, `source${ext}`);
  fs.renameSync(filePath, dest);
  return insertProject({
    title: title || sanitizeTitle(originalName),
    sourceType: 'upload',
    sourcePath: dest,
    attestation: true,
    note: 'Uploaded by the owner.',
    status: 'created',
    stage: 'source ready',
  });
}

/** Download an authorized direct media URL (never a YouTube page). */
export async function createProjectFromMediaUrl({ url, title, attestation }) {
  if (!attestation) throw new Error('You must confirm you own this video or have permission to edit it.');
  if (!/^https:\/\//i.test(url)) throw new Error('Only HTTPS media URLs are accepted.');
  if (parseYouTubeId(url)) throw new Error('Use the YouTube source flow for YouTube links.');
  if (!isDirectMediaUrl(url)) throw new Error('Provide a direct video file URL (.mp4, .mov, .mkv, .webm).');

  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`Could not download the media (HTTP ${res.status}).`);
  const type = String(res.headers.get('content-type') || '');
  if (type && !/video|octet-stream/i.test(type)) throw new Error(`The URL returned ${type}, not a video file.`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length && length > MAX_UPLOAD_BYTES) throw new Error('The remote file is larger than the configured upload limit.');

  const id = uid('pr');
  const paths = ensureProjectDirs(id);
  const dest = path.join(paths.dir, 'source.mp4');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_UPLOAD_BYTES) throw new Error('The remote file is larger than the configured upload limit.');
  fs.writeFileSync(dest, buffer);
  const info = await probe(dest);
  return insertProject({
    title: title || sanitizeTitle(decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Cloud media')),
    sourceType: 'url',
    sourceUrl: url,
    sourcePath: dest,
    attestation: true,
    note: 'Authorized direct media URL.',
    status: 'created',
    stage: 'source ready',
  });
}

/**
 * A YouTube URL is only accepted when the connected channel owns the video.
 * The agent reads authorized metadata/captions, but rendering still needs the
 * original file — YouTube's API does not provide a legal download path.
 */
export async function createProjectFromYouTube({ url, title }) {
  const videoId = parseYouTubeId(url);
  if (!videoId) throw new Error('That is not a recognizable YouTube video URL.');

  if (!youtubeConfigured()) {
    const project = insertProject({
      title: title || `YouTube video ${videoId}`,
      sourceType: 'youtube',
      sourceUrl: url,
      status: 'awaiting_source',
      stage: 'authorization required',
      note: 'YouTube OAuth is not configured on this deployment. Upload the original file to continue.',
    });
    return { project, requiresUpload: true, message: 'YouTube OAuth is not configured. Upload the original video file to continue.' };
  }

  const channel = getChannel();
  if (!channel) {
    const project = insertProject({
      title: title || `YouTube video ${videoId}`,
      sourceType: 'youtube',
      sourceUrl: url,
      status: 'awaiting_source',
      stage: 'connect channel',
      note: 'Connect your YouTube channel to verify ownership, then upload the original file.',
    });
    return { project, requiresUpload: true, message: 'Connect your YouTube channel so the agent can verify you own this video.' };
  }

  let video = null;
  try {
    const token = await getAccessToken();
    video = await fetchOwnedVideo(token, videoId);
    if (!video) throw new Error('Video not found.');
    if (video.channelId !== channel.channel_id) {
      throw new Error('This video belongs to a channel you have not connected. The agent can only process content you own.');
    }
    const captions = await fetchOwnedCaptions(token, videoId);
    const project = insertProject({
      title: video.title || title || `YouTube video ${videoId}`,
      sourceType: 'youtube',
      sourceUrl: url,
      status: 'awaiting_source',
      stage: 'awaiting original file',
      note: 'Ownership verified through the YouTube Data API. Upload the original file to render clips (YouTube does not allow downloads).',
    });
    if (captions.segments?.length) {
      db.prepare('UPDATE projects SET transcript=?, transcript_source=?, updated_at=? WHERE id=?').run(
        JSON.stringify(captions.segments),
        'youtube-captions',
        now(),
        project.id,
      );
    }
    return {
      project: getProject(project.id),
      requiresUpload: true,
      verified: true,
      message:
        'Ownership verified. YouTube does not permit downloading videos, so upload the original file — the agent will reuse the authorized captions it already fetched.',
    };
  } catch (err) {
    const project = insertProject({
      title: title || `YouTube video ${videoId}`,
      sourceType: 'youtube',
      sourceUrl: url,
      status: 'awaiting_source',
      stage: 'authorization failed',
      note: err.message,
    });
    return { project, requiresUpload: true, verified: false, message: `${err.message} Upload the original file to continue.` };
  }
}

/** Attach an authorized file to an existing project (e.g. a verified YouTube source). */
export async function attachSourceToProject(projectId, { filePath, originalName, attestation }) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (!attestation) throw new Error('You must confirm you own this video or have permission to edit it.');
  const info = await probe(filePath);
  const paths = ensureProjectDirs(projectId);
  const ext = (path.extname(originalName || '') || '.mp4').toLowerCase();
  const dest = path.join(paths.dir, `source${ext}`);
  fs.renameSync(filePath, dest);
  db.prepare(
    'UPDATE projects SET source_path=?, source_attestation=1, duration=?, width=?, height=?, has_audio=?, size_bytes=?, status=?, stage=?, updated_at=? WHERE id=?',
  ).run(dest, info.duration, info.width, info.height, info.hasAudio ? 1 : 0, info.sizeBytes, 'created', 'source ready', now(), projectId);
  return getProject(projectId);
}

export function startWorkflow(projectId, count) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const prefs = getPreferences();
  const target = Math.max(1, Math.min(10, Number(count) || Number(prefs.shortsPerVideo) || 5));
  db.prepare("UPDATE projects SET status='queued', stage='queued', progress=0, error=NULL, updated_at=? WHERE id=?").run(now(), projectId);
  const job = enqueueJob({ type: 'autopilot', projectId, payload: { count: target } });
  return job;
}

export function approveShort(shortId, approved = true) {
  const short = getShort(shortId);
  if (!short) throw new Error('Short not found');
  if (!short.file_path) throw new Error('This Short has not been rendered yet.');
  const status = approved ? STATUS.APPROVED : STATUS.DRAFT;
  db.prepare('UPDATE shorts SET status=?, approved_at=?, updated_at=? WHERE id=?').run(
    status,
    approved ? now() : null,
    now(),
    shortId,
  );
  addMemory(`${approved ? 'Approved' : 'Rejected'} Short "${short.title}" for publishing.`, 'approval');
  notify(approved ? 'success' : 'info', approved ? 'Short approved' : 'Short sent back', short.title, '/shorts');
  return getShort(shortId);
}

export function publishPreview(shortId) {
  const short = getShort(shortId);
  if (!short) throw new Error('Short not found');
  const project = getProject(short.project_id);
  const channel = getChannel();
  const hashtags = Array.isArray(short.hashtags) ? short.hashtags : [];
  return {
    shortId: short.id,
    title: short.title,
    description: short.description,
    hashtags,
    tags: [...new Set([...(short.keywords || []), ...hashtags.map((h) => h.replace('#', ''))])].slice(0, 15),
    visibility: short.visibility || 'private',
    scheduledAt: short.scheduled_at,
    categoryId: short.category,
    duration: short.duration,
    thumbnailUrl: `/api/media/${project.id}/thumbs/${short.id}.jpg`,
    videoUrl: `/api/media/${project.id}/shorts/${short.id}.mp4`,
    channel: channel ? { title: channel.title, channelId: channel.channel_id, thumbnail: channel.thumbnail } : null,
    status: short.status,
    approved: short.status === STATUS.APPROVED || short.status === STATUS.SCHEDULED,
    youtubeReady: youtubeConfigured() && Boolean(channel),
    projectTitle: project?.title,
  };
}

export function publishShort(shortId, { visibility = 'private', scheduledAt = null, confirm = false } = {}) {
  const short = getShort(shortId);
  if (!short) throw new Error('Short not found');
  if (!short.file_path) throw new Error('Render the Short before publishing.');
  if (!confirm) throw new Error('Explicit confirmation is required before publishing to YouTube.');
  if (![STATUS.APPROVED, STATUS.SCHEDULED].includes(short.status)) {
    throw new Error('This Short is not approved. Approve it in the publishing preview first.');
  }
  if (!youtubeConfigured()) throw new Error('YouTube OAuth is not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.');
  if (!getChannel()) throw new Error('Connect your YouTube channel first.');
  if (visibility === 'public' && !confirm) throw new Error('Public publishing requires explicit confirmation.');

  if (scheduledAt) {
    const when = new Date(scheduledAt).getTime();
    if (!Number.isFinite(when) || when < Date.now() + 60_000) throw new Error('Pick a schedule time at least a minute in the future.');
    db.prepare('UPDATE shorts SET status=?, scheduled_at=?, visibility=?, updated_at=? WHERE id=?').run(
      STATUS.SCHEDULED,
      when,
      visibility,
      now(),
      shortId,
    );
    const job = enqueueJob({
      type: 'publish_short',
      projectId: short.project_id,
      shortId,
      payload: { visibility, scheduledAt: when },
      runAt: when,
      maxAttempts: 3,
    });
    return { scheduled: true, job, when };
  }

  db.prepare('UPDATE shorts SET visibility=?, updated_at=? WHERE id=?').run(visibility, now(), shortId);
  const job = enqueueJob({
    type: 'publish_short',
    projectId: short.project_id,
    shortId,
    payload: { visibility, scheduledAt: null },
    maxAttempts: 3,
  });
  return { scheduled: false, job };
}

/* ------------------------------------------------------------------ *
 * Chat command center
 * ------------------------------------------------------------------ */

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function extractCount(text) {
  const digit = text.match(/\b(\d{1,2})\b/);
  if (digit) return Math.max(1, Math.min(10, Number(digit[1])));
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return value;
  }
  return null;
}

function ruleIntent(message, context) {
  const text = String(message);
  const lower = text.toLowerCase();
  const url = text.match(URL_RE)?.[1] || null;
  const count = extractCount(lower);

  if (/(connect|link).*(youtube|channel)/.test(lower)) return { intent: 'connect_youtube', params: {}, reply: 'Opening the YouTube authorization flow.' };
  if (/(waiting|awaiting|pending).*(approval|review)|list.*approval|show.*approval/.test(lower)) {
    return { intent: 'list_approvals', params: {}, reply: 'Here is everything waiting for your approval.' };
  }
  if (/^(upload|publish)\b/.test(lower) || /(publish|upload).*(approved|short)/.test(lower)) {
    return { intent: 'publish_short', params: { shortId: context.latestApprovedShortId || null }, reply: 'Here is the publishing preview — confirm to send it to YouTube.' };
  }
  if (/\bapprove\b/.test(lower) && !/approval/.test(lower)) {
    return { intent: 'approve_short', params: { shortId: context.latestAwaitingShortId || null }, reply: 'Approving that Short.' };
  }
  if (/(schedule|tomorrow|tonight)/.test(lower)) return { intent: 'schedule_short', params: { shortId: context.latestApprovedShortId || null }, reply: 'Preparing a scheduled upload.' };
  if (/(tasks?|jobs?|progress|status of)/.test(lower)) return { intent: 'list_tasks', params: {}, reply: 'Here is the current task queue.' };
  if (/(mode)\s*[abc]\b/.test(lower)) {
    const mode = lower.match(/mode\s*([abc])/)[1].toUpperCase();
    return { intent: 'set_mode', params: { mode }, reply: `Switching the agent to automation mode ${mode}.` };
  }
  if (/(emotional|funny|motivational|educational|dramatic)/.test(lower) && /(moment|clip|short)/.test(lower)) {
    const emotion = lower.match(/(emotional|funny|motivational|educational|dramatic)/)[1];
    return { intent: 'find_moments', params: { emotion, count }, reply: `Looking for ${emotion} moments.` };
  }
  if (/(title|description|hashtag|seo)/.test(lower)) return { intent: 'generate_seo', params: { shortId: null }, reply: 'Reviewing the SEO metadata of the latest Shorts.' };
  if (url) return { intent: 'create_project', params: { sourceUrl: url, count: count || 5 }, reply: 'Starting the full autopilot workflow on that source.' };
  if (/(make|create|turn|generate).*(short|clip)/.test(lower)) {
    return { intent: 'make_shorts', params: { count: count || 5 }, reply: 'Queuing Short generation on the most recent project.' };
  }
  return { intent: 'help', params: {}, reply: null };
}

export async function handleChat(message) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Message is empty');
  addChat('user', text);

  const prefs = getPreferences();
  const awaiting = listShorts({ status: STATUS.AWAITING_APPROVAL, limit: 5 });
  const approved = listShorts({ status: STATUS.APPROVED, limit: 5 });
  const projects = db.prepare('SELECT id, title, status FROM projects ORDER BY created_at DESC LIMIT 5').all();
  const channel = getChannel();
  const context = {
    latestAwaitingShortId: awaiting[0]?.id || null,
    latestApprovedShortId: approved[0]?.id || null,
    latestProjectId: projects[0]?.id || null,
    projects: projects.map((p) => ({ id: p.id, title: p.title, status: p.status })),
    awaitingCount: awaiting.length,
    approvedCount: approved.length,
    channel: channel ? { title: channel.title } : null,
    mode: prefs.approvalMode,
    aiConfigured: aiConfigured(),
    youtubeConfigured: youtubeConfigured(),
  };

  let parsed = null;
  if (geminiReady()) {
    try {
      parsed = await parseCommand({ message: text, context });
    } catch {
      parsed = null;
    }
  }
  if (!parsed || !parsed.intent) parsed = ruleIntent(text, context);

  const actions = [];
  let reply = parsed.reply || '';
  const params = parsed.params || {};

  try {
    switch (parsed.intent) {
      case 'create_project': {
        const url = params.sourceUrl || text.match(URL_RE)?.[1];
        if (!url) {
          reply = 'Send me a video URL, or upload a file in Projects. I need an authorized source to start.';
          break;
        }
        const count = params.count || extractCount(text) || Number(prefs.shortsPerVideo);
        let result;
        if (parseYouTubeId(url)) result = await createProjectFromYouTube({ url });
        else result = await createProjectFromMediaUrl({ url, attestation: true });
        if (result.requiresUpload) {
          reply = `${result.message} Project "${result.project.title}" is saved and waiting for the file.`;
          actions.push({ type: 'open_project', label: 'Open project', projectId: result.project.id });
          actions.push({ type: 'needs_upload', label: 'Upload original file', projectId: result.project.id });
        } else {
          const job = startWorkflow(result.project.id, count);
          reply = `Queued the full workflow: analyze "${result.project.title}", pick the ${count} best moments, render 9:16 Shorts with captions, then prepare SEO and a publishing preview.`;
          actions.push({ type: 'job', label: 'View task', jobId: job.id, projectId: result.project.id });
        }
        break;
      }
      case 'make_shorts': {
        const projectId = params.projectId || context.latestProjectId;
        if (!projectId) {
          reply = 'There is no analyzed project yet. Upload a video first.';
          break;
        }
        const job = startWorkflow(projectId, params.count || extractCount(text) || 5);
        reply = `Queued Short generation on "${getProject(projectId)?.title}". I will report progress in Tasks.`;
        actions.push({ type: 'job', label: 'View task', jobId: job.id, projectId });
        break;
      }
      case 'list_approvals': {
        const list = listShorts({ status: STATUS.AWAITING_APPROVAL, limit: 20 });
        reply = list.length
          ? `${list.length} Short${list.length === 1 ? '' : 's'} ready for review. Open one to preview and approve.`
          : 'Nothing is waiting for approval right now.';
        for (const s of list.slice(0, 5)) actions.push({ type: 'short', label: s.title, shortId: s.id, status: s.status });
        break;
      }
      case 'approve_short': {
        const shortId = params.shortId || context.latestAwaitingShortId;
        if (!shortId) {
          reply = 'No Short is waiting for approval.';
          break;
        }
        const updated = approveShort(shortId, true);
        reply = `Approved "${updated.title}". It is ready for the publishing preview.`;
        actions.push({ type: 'publish_preview', label: 'Open publishing preview', shortId });
        break;
      }
      case 'publish_short': {
        const shortId = params.shortId || context.latestApprovedShortId;
        if (!shortId) {
          reply = 'There is no approved Short to publish. Approve one first.';
          break;
        }
        const preview = publishPreview(shortId);
        reply = 'Here is the final publishing preview. I will only upload after you confirm.';
        actions.push({ type: 'publish_preview', label: 'Review and confirm', shortId });
        actions.push({ type: 'preview', shortId, preview });
        break;
      }
      case 'schedule_short': {
        const shortId = params.shortId || context.latestApprovedShortId;
        if (!shortId) {
          reply = 'Approve a Short first, then I can schedule it.';
          break;
        }
        reply = 'Pick a date and time in the publishing preview; I will queue the upload for that slot.';
        actions.push({ type: 'publish_preview', label: 'Choose schedule', shortId });
        break;
      }
      case 'list_tasks': {
        const jobs = listJobs({ limit: 6 });
        reply = jobs.length
          ? jobs.map((j) => `${j.type}: ${j.status} (${j.progress}%)${j.message ? ` — ${j.message}` : ''}`).join('\n')
          : 'No tasks have run yet.';
        for (const j of jobs.slice(0, 4)) actions.push({ type: 'job', label: `${j.type} · ${j.status}`, jobId: j.id });
        break;
      }
      case 'find_moments': {
        const emotion = params.emotion;
        const all = listShorts({ limit: 100 });
        const filtered = emotion ? all.filter((s) => s.emotion === emotion) : all;
        reply = filtered.length
          ? `${filtered.length} ${emotion || ''} moment${filtered.length === 1 ? '' : 's'} found in your rendered Shorts.`
          : `No ${emotion || 'matching'} moments yet. Run the agent on a video and I will rank them by emotion.`;
        for (const s of filtered.slice(0, 5)) actions.push({ type: 'short', label: s.title, shortId: s.id, status: s.status });
        break;
      }
      case 'generate_seo': {
        const latest = listShorts({ limit: 3 });
        reply = latest.length
          ? 'Latest metadata is ready for review. Every title is generated from the actual clip transcript.'
          : 'Generate Shorts first — SEO is written from the clip content.';
        for (const s of latest) actions.push({ type: 'short', label: s.title, shortId: s.id, status: s.status });
        break;
      }
      case 'set_mode': {
        const mode = String(params.mode || 'B').toUpperCase();
        if (!['A', 'B', 'C'].includes(mode)) {
          reply = 'Mode must be A, B or C.';
          break;
        }
        setPreference('approvalMode', mode);
        reply =
          mode === 'A'
            ? 'Mode A active: I generate everything automatically and leave the Shorts as drafts.'
            : mode === 'B'
              ? 'Mode B active: I generate everything, then wait for your approval before publishing.'
              : 'Mode C active: I prepare content and you can schedule the approved uploads.';
        break;
      }
      case 'connect_youtube': {
        reply = youtubeConfigured()
          ? 'Use the Connect YouTube button to authorize the official OAuth flow.'
          : 'YouTube OAuth is not configured yet. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in Settings → Environment variables.';
        actions.push({ type: 'connect_youtube', label: 'Connect YouTube' });
        break;
      }
      case 'set_preference': {
        if (params.key && params.value != null) {
          setPreference(params.key, params.value);
          reply = `Saved preference ${params.key} = ${params.value}.`;
        } else {
          reply = 'Tell me the preference to change, for example "set my Short length to 45 seconds".';
        }
        break;
      }
      default: {
        reply = [
          'I am your YouTube AI agent. I can:',
          '• Turn a video into Shorts — send a URL or upload a file',
          '• Find emotional or motivational moments',
          '• Generate titles, descriptions and hashtags',
          '• Show what is waiting for approval',
          '• Prepare and publish approved uploads',
          'Try: "Turn this video into five Shorts" or "Show me all videos waiting for approval".',
        ].join('\n');
      }
    }
  } catch (err) {
    reply = `I could not complete that: ${err.message}`;
    actions.push({ type: 'error', label: err.message });
  }

  addChat('assistant', reply, actions);
  return { reply, actions, intent: parsed.intent };
}

export { MAX_SOURCE_SECONDS };
