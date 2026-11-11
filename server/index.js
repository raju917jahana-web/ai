import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import {
  APP_PASSWORD,
  APP_SECRET,
  HOST,
  MAX_UPLOAD_BYTES,
  MEDIA_DIR,
  PORT,
  STATUS,
  TMP_DIR,
  aiConfigured,
  youtubeConfigured,
} from './config.js';
import {
  addChat,
  addMemory,
  dashboardStats,
  db,
  deleteMemory,
  disconnectChannel,
  getChannel,
  getJob,
  getPreferences,
  getProject,
  getShort,
  jobLogs,
  listChat,
  listJobs,
  listMemories,
  listNotifications,
  listProjects,
  listShorts,
  logJob,
  markNotificationsRead,
  notify,
  now,
  resetStaleJobs,
  setPreferences,
  updateChannelTokens,
} from './db.js';
import { enqueueJob, pauseJob, registerHandler, resumeJob, cancelJob, retryJob, startWorker } from './lib/queue.js';
import { mediaPaths, rerenderShort, runAutopilot } from './lib/pipeline.js';
import {
  attachSourceToProject,
  createProjectFromMediaUrl,
  createProjectFromUpload,
  createProjectFromYouTube,
  handleChat,
  publishPreview,
  publishShort,
  approveShort,
  startWorkflow,
} from './lib/agent.js';
import { authUrl, exchangeCode, fetchChannelInfo, fetchVideoStatus, revokeToken, signState, uploadVideo, verifyState } from './lib/youtube.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https://i.ytimg.com https://yt3.ggpht.com; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
  next();
});

/* ------------------------------- auth ---------------------------------- */

const COOKIE = 'yp_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function signSession(expires) {
  const mac = crypto.createHmac('sha256', APP_SECRET).update(String(expires)).digest('hex');
  return `${expires}.${mac}`;
}

function sessionValid(token) {
  if (!token) return false;
  const [expires, mac] = String(token).split('.');
  if (!expires || !mac) return false;
  const expected = crypto.createHmac('sha256', APP_SECRET).update(expires).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expires) > Date.now();
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (sessionValid(readCookie(req, COOKIE))) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

app.get('/api/health', (req, res) => res.json({ ok: true, time: now() }));

app.get('/api/auth/status', (req, res) => {
  res.json({ passwordRequired: Boolean(APP_PASSWORD), authenticated: !APP_PASSWORD || sessionValid(readCookie(req, COOKIE)) });
});

app.post('/api/auth/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const provided = String(req.body?.password || '');
  const a = Buffer.from(crypto.createHash('sha256').update(provided).digest());
  const b = Buffer.from(crypto.createHash('sha256').update(APP_PASSWORD).digest());
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Incorrect password' });
  const expires = Date.now() + SESSION_TTL_MS;
  res.cookie(COOKIE, signSession(expires), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ---------------------------- job handlers ----------------------------- */

registerHandler('autopilot', async ({ job, payload, ctx }) => {
  const project = getProject(job.project_id);
  if (!project) throw new Error('Project no longer exists');
  return runAutopilot({ project, count: payload.count, ctx });
});

registerHandler('rerender_short', async ({ payload, ctx }) => rerenderShort({ shortId: payload.shortId, effects: payload.effects, ctx }));

registerHandler('publish_short', async ({ job, payload, ctx }) => {
  const short = getShort(job.short_id);
  if (!short) throw new Error('Short no longer exists');
  if (!short.file_path || !fs.existsSync(short.file_path)) throw new Error('The rendered file is missing on disk.');
  if (![STATUS.APPROVED, STATUS.SCHEDULED, STATUS.PUBLISHED].includes(short.status)) {
    throw new Error('Publishing requires an approved Short.');
  }
  const project = getProject(short.project_id);
  const hashtags = Array.isArray(short.hashtags) ? short.hashtags : [];
  const description = [short.description || '', hashtags.join(' ')].filter(Boolean).join('\n\n').slice(0, 4900);
  const tags = [...new Set([...(short.keywords || []), ...hashtags.map((h) => String(h).replace('#', ''))])].slice(0, 25);

  ctx.report(5, 'upload', 'Opening a resumable YouTube upload session');
  db.prepare("UPDATE shorts SET status='publishing', upload_progress=0, error=NULL, updated_at=? WHERE id=?").run(now(), short.id);

  const result = await uploadVideo({
    filePath: short.file_path,
    title: short.title || project?.title || 'YouTube Short',
    description,
    tags,
    categoryId: short.category || '22',
    privacyStatus: payload.visibility || short.visibility || 'private',
    publishAt: payload.scheduledAt || null,
    onProgress: (pct) => {
      ctx.checkpoint();
      ctx.report(5 + Math.round(pct * 0.9), 'upload', `Uploading to YouTube — ${pct}%`);
      db.prepare('UPDATE shorts SET upload_progress=?, updated_at=? WHERE id=?').run(pct, now(), short.id);
    },
  });

  db.prepare(
    'UPDATE shorts SET status=?, youtube_video_id=?, published_url=?, published_at=?, upload_progress=100, visibility=?, updated_at=? WHERE id=?',
  ).run(STATUS.PUBLISHED, result.videoId, result.url, now(), payload.visibility || short.visibility || 'private', now(), short.id);
  notify('success', 'Published to YouTube', `${short.title} → ${result.url}`, '/shorts');
  addMemory(`Published "${short.title}" to YouTube as ${result.url}.`, 'publish');
  return result;
});

registerHandler('verify_publish', async ({ job, ctx }) => {
  const short = getShort(job.short_id);
  if (!short?.youtube_video_id) throw new Error('No uploaded video to verify');
  ctx.report(40, 'verify', 'Reading the published video status');
  const status = await fetchVideoStatus(short.youtube_video_id);
  ctx.report(100, 'verify', 'Status received');
  return { status: status?.status?.privacyStatus || 'unknown', views: status?.statistics?.viewCount || '0' };
});

startWorker();
resetStaleJobs();

/* ------------------------------ api ----------------------------------- */

const api = express.Router();
api.use(requireAuth);

const upload = multer({
  storage: multer.diskStorage({ destination: TMP_DIR, filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`) }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /^video\//i.test(file.mimetype || '') || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only video files are accepted'), ok);
  },
});

api.get('/config', (req, res) => {
  const channel = getChannel();
  res.json({
    aiConfigured: aiConfigured(),
    youtubeConfigured: youtubeConfigured(),
    channel: channel
      ? { title: channel.title, channelId: channel.channel_id, handle: channel.handle, thumbnail: channel.thumbnail, subscribers: channel.subscribers, videos: channel.videos }
      : null,
    maxUploadMB: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)),
    preferences: getPreferences(),
  });
});

api.get('/state', (req, res) => {
  res.json({
    stats: dashboardStats(),
    channel: (() => {
      const channel = getChannel();
      return channel
        ? { title: channel.title, channelId: channel.channel_id, handle: channel.handle, thumbnail: channel.thumbnail, subscribers: channel.subscribers, videos: channel.videos }
        : null;
    })(),
    projects: listProjects(12),
    shorts: listShorts({ limit: 60 }),
    jobs: listJobs({ limit: 25 }),
    notifications: listNotifications(12),
    preferences: getPreferences(),
    integrations: { ai: aiConfigured(), youtube: youtubeConfigured() },
    counts: {
      awaiting: listShorts({ status: STATUS.AWAITING_APPROVAL, limit: 200 }).length,
      approved: listShorts({ status: STATUS.APPROVED, limit: 200 }).length,
      scheduled: listShorts({ status: STATUS.SCHEDULED, limit: 200 }).length,
    },
  });
});

api.get('/projects', (req, res) => {
  const projects = listProjects(100).map((p) => {
    const shorts = listShorts({ projectId: p.id, limit: 50 });
    return { ...p, transcript: undefined, shorts: shorts.map((s) => ({ id: s.id, status: s.status, title: s.title, thumb_path: s.thumb_path, duration: s.duration, idx: s.idx })) };
  });
  res.json({ projects });
});

api.get('/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const shorts = listShorts({ projectId: project.id, limit: 100 });
  res.json({ project: { ...project, transcript: project.transcript ? project.transcript.slice(0, 4000) : null }, shorts });
});

api.post('/projects', upload.single('video'), async (req, res, next) => {
  try {
    const attestation = req.body.attestation === 'true' || req.body.attestation === true;
    const title = req.body.title || null;
    let result;
    if (req.file) {
      const project = await createProjectFromUpload({ filePath: req.file.path, originalName: req.file.originalname, title, attestation });
      result = { project, requiresUpload: false };
    } else if (req.body.sourceUrl) {
      const url = String(req.body.sourceUrl).trim();
      if (/youtube\.com|youtu\.be/i.test(url)) result = await createProjectFromYouTube({ url, title });
      else result = { project: await createProjectFromMediaUrl({ url, title, attestation }), requiresUpload: false };
    } else {
      return res.status(400).json({ error: 'Provide a video file or an authorized source URL.' });
    }

    let job = null;
    if (!result.requiresUpload && result.project?.source_path) job = startWorkflow(result.project.id, req.body.count);
    res.status(201).json({ ...result, job });
  } catch (err) {
    if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {});
    next(err);
  }
});

api.post('/projects/:id/source', upload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Attach the original video file.' });
    const project = await attachSourceToProject(req.params.id, {
      filePath: req.file.path,
      originalName: req.file.originalname,
      attestation: req.body.attestation === 'true' || req.body.attestation === true,
    });
    const job = startWorkflow(project.id, req.body.count);
    res.json({ project, job });
  } catch (err) {
    if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {});
    next(err);
  }
});

api.post('/projects/:id/run', (req, res, next) => {
  try {
    const job = startWorkflow(req.params.id, req.body?.count);
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

api.delete('/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const running = db.prepare("SELECT id FROM jobs WHERE project_id = ? AND status IN ('running','queued','pause_requested','paused')").all(project.id);
  for (const job of running) cancelJob(job.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  const dir = path.join(MEDIA_DIR, project.id);
  fs.rm(dir, { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

api.get('/shorts', (req, res) => {
  const { status, projectId } = req.query;
  res.json({ shorts: listShorts({ status: status || undefined, projectId: projectId || undefined, limit: 200 }) });
});

api.get('/shorts/:id', (req, res) => {
  const short = getShort(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });
  const project = getProject(short.project_id);
  const transcript = Array.isArray(project?.transcript) ? project.transcript : [];
  const clipTranscript = transcript.filter((s) => s.end > short.start_sec && s.start < short.end_sec);
  res.json({ short, project: project ? { id: project.id, title: project.title } : null, clipTranscript });
});

api.patch('/shorts/:id', (req, res, next) => {
  try {
    const short = getShort(req.params.id);
    if (!short) return res.status(404).json({ error: 'Short not found' });
    const fields = ['title', 'description', 'pinned_comment', 'visibility', 'category', 'thumbnail_text'];
    const updates = {};
    for (const field of fields) if (req.body[field] !== undefined) updates[field] = String(req.body[field]).slice(0, 4900);
    if (req.body.hashtags !== undefined) updates.hashtags = JSON.stringify((Array.isArray(req.body.hashtags) ? req.body.hashtags : String(req.body.hashtags).split(/\s+/)).filter(Boolean).slice(0, 20));
    if (req.body.keywords !== undefined) updates.keywords = JSON.stringify((Array.isArray(req.body.keywords) ? req.body.keywords : []).slice(0, 25));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE shorts SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(updates), now(), short.id);
    res.json({ short: getShort(short.id) });
  } catch (err) {
    next(err);
  }
});

api.post('/shorts/:id/approve', (req, res, next) => {
  try {
    const approved = req.body?.approved !== false;
    const short = approveShort(req.params.id, approved);
    res.json({ short, preview: approved ? publishPreview(short.id) : null });
  } catch (err) {
    next(err);
  }
});

api.get('/shorts/:id/preview', (req, res, next) => {
  try {
    res.json({ preview: publishPreview(req.params.id) });
  } catch (err) {
    next(err);
  }
});

api.post('/shorts/:id/publish', (req, res, next) => {
  try {
    const result = publishShort(req.params.id, {
      visibility: req.body?.visibility || 'private',
      scheduledAt: req.body?.scheduledAt || null,
      confirm: req.body?.confirm === true,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

api.post('/shorts/:id/director', async (req, res, next) => {
  try {
    const short = getShort(req.params.id);
    if (!short) return res.status(404).json({ error: 'Short not found' });
    const effects = Array.isArray(req.body?.effects) ? req.body.effects : [];
    const job = enqueueJob({ type: 'rerender_short', projectId: short.project_id, shortId: short.id, payload: { shortId: short.id, effects }, maxAttempts: 2 });
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

api.get('/jobs', (req, res) => {
  res.json({ jobs: listJobs({ limit: Number(req.query.limit) || 50, status: req.query.status || undefined, projectId: req.query.projectId || undefined }) });
});

api.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job, logs: jobLogs(job.id, 200) });
});

for (const [action, fn] of Object.entries({ pause: pauseJob, resume: resumeJob, cancel: cancelJob, retry: retryJob })) {
  api.post(`/jobs/:id/${action}`, (req, res, next) => {
    try {
      res.json({ job: fn(req.params.id) });
    } catch (err) {
      next(err);
    }
  });
}

api.get('/chat', (req, res) => res.json({ messages: listChat(80) }));

api.post('/chat', async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const result = await handleChat(message);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

api.post('/chat/clear', (req, res) => {
  db.prepare('DELETE FROM chat_messages').run();
  res.json({ ok: true });
});

api.get('/preferences', (req, res) => res.json({ preferences: getPreferences() }));

api.put('/preferences', (req, res, next) => {
  try {
    const prefs = setPreferences(req.body || {});
    addMemory(`Updated agent preferences: ${Object.keys(req.body || {}).join(', ')}.`, 'preference');
    res.json({ preferences: prefs });
  } catch (err) {
    next(err);
  }
});

api.get('/memories', (req, res) => res.json({ memories: listMemories(100) }));
api.post('/memories', (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Memory text is required' });
    res.json({ memories: listMemories(100), created: addMemory(text, 'user') });
  } catch (err) {
    next(err);
  }
});
api.delete('/memories/:id', (req, res) => {
  deleteMemory(req.params.id);
  res.json({ memories: listMemories(100) });
});

api.get('/notifications', (req, res) => res.json({ notifications: listNotifications(40) }));
api.post('/notifications/read', (req, res) => {
  markNotificationsRead();
  res.json({ ok: true });
});

/* ------------------------------ youtube -------------------------------- */

api.get('/youtube/connect', (req, res) => {
  if (!youtubeConfigured()) return res.status(400).json({ error: 'YouTube OAuth is not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.' });
  const redirectUri = `${req.protocol}://${req.get('host')}/api/youtube/callback`;
  const state = signState({ ts: Date.now() }, APP_SECRET);
  res.json({ url: authUrl({ redirectUri, state }), redirectUri });
});

api.get('/youtube/status', (req, res) => {
  const channel = getChannel();
  res.json({
    configured: youtubeConfigured(),
    channel: channel
      ? { title: channel.title, channelId: channel.channel_id, handle: channel.handle, thumbnail: channel.thumbnail, subscribers: channel.subscribers, videos: channel.videos, connectedAt: channel.connected_at }
      : null,
  });
});

api.post('/youtube/disconnect', async (req, res, next) => {
  try {
    const channel = getChannel();
    if (channel?.refresh_token) {
      try {
        await revokeToken(channel.refresh_token);
      } catch {
        /* revocation is best effort; local tokens are removed regardless */
      }
    }
    disconnectChannel();
    notify('info', 'YouTube disconnected', 'Stored tokens were removed and access was revoked.', '/settings');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

api.get('/youtube/videos/:id', async (req, res, next) => {
  try {
    const channel = getChannel();
    if (!channel) return res.status(400).json({ error: 'Connect your YouTube channel first.' });
    const status = await fetchVideoStatus(req.params.id);
    res.json({ video: status });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ media ---------------------------------- */

function sendMedia(res, baseDir, relative) {
  const resolved = path.resolve(baseDir, relative);
  const root = path.resolve(baseDir);
  if (!resolved.startsWith(root + path.sep)) return res.status(400).json({ error: 'Invalid media path' });
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return res.status(404).json({ error: 'Media not found' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(resolved);
}

api.get('/media/:projectId/:folder/:file', requireAuth, (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const paths = mediaPaths(project.id);
  const folder = req.params.folder;
  if (!['shorts', 'thumbs', 'subs'].includes(folder)) return res.status(400).json({ error: 'Invalid media folder' });
  sendMedia(res, paths[folder === 'shorts' ? 'shortsDir' : folder === 'thumbs' ? 'thumbsDir' : 'subsDir'], req.params.file);
});

api.get('/media/:projectId/source', requireAuth, (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project?.source_path) return res.status(404).json({ error: 'Source not found' });
  sendMedia(res, path.dirname(project.source_path), path.basename(project.source_path));
});

app.use('/api', api);

/* --------------------------- oauth callback ---------------------------- */

app.get('/api/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?youtube=error&reason=${encodeURIComponent(String(error))}`);
  if (!code || !verifyState(String(state || ''), APP_SECRET)) return res.redirect('/?youtube=error&reason=invalid_state');
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/youtube/callback`;
    const tokens = await exchangeCode({ code: String(code), redirectUri });
    const channel = await fetchChannelInfo(tokens.accessToken);
    const id = `ch_${channel.id}`;
    db.prepare(
      `INSERT INTO channels (id, platform, channel_id, title, handle, thumbnail, subscribers, videos, access_token, refresh_token, token_expiry, scopes, connected_at)
       VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, channel_id) DO UPDATE SET title=excluded.title, handle=excluded.handle, thumbnail=excluded.thumbnail,
         subscribers=excluded.subscribers, videos=excluded.videos, access_token=excluded.access_token,
         refresh_token=COALESCE(excluded.refresh_token, channels.refresh_token), token_expiry=excluded.token_expiry,
         scopes=excluded.scopes, connected_at=excluded.connected_at`,
    ).run(
      id,
      channel.id,
      channel.title,
      channel.handle,
      channel.thumbnail,
      channel.subscribers,
      channel.videos,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiry,
      tokens.scope,
      now(),
    );
    notify('success', 'YouTube channel connected', channel.title, '/settings');
    addMemory(`Connected YouTube channel "${channel.title}".`, 'channel');
    res.redirect('/?youtube=connected');
  } catch (err) {
    logJob('oauth', `OAuth failed: ${err.message}`, 'error');
    res.redirect(`/?youtube=error&reason=${encodeURIComponent(err.message)}`);
  }
});

app.post('/api/youtube/refresh', async (req, res) => {
  try {
    const { getAccessToken } = await import('./lib/youtube.js');
    await getAccessToken();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------- static -------------------------------- */

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => res.type('text/plain').send('Client build not found. Run "npm run build".'));
}

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
  if (!res.headersSent) res.status(status).json({ error: err.message || 'Request failed' });
  else next(err);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`YouTube Autopilot AI listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}

export { app, server };
