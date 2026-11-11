import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR, STATUS } from '../config.js';
import { db, getProject, getShort, getPreferences, logJob, notify, now, parseJson, shortRow, uid } from '../db.js';
import { audioEnergy, detectScenes, detectSilence, extractAudio, extractFrame, frameSamples, measureLoudness, probe, sliceAudio } from './ffmpeg.js';
import { buildAss, renderShort, renderThumbnail } from './render.js';
import { aiConfigured, directClip, generateSeo, inspectClip, selectMoments, transcribeChunk } from './gemini.js';

const CHUNK_SECONDS = 8 * 60;

const STOPWORDS = new Set(
  'the a an and or but if then than that this these those you your yours we our us i me my he she it they them his her its of to in on for with at by from as is are was were be been being do does did not no so just very really about into over after before when while what which who how why can could should would will shall may might have has had here there'.split(
    ' ',
  ),
);

export const mediaPaths = (projectId) => {
  const dir = path.join(MEDIA_DIR, projectId);
  return {
    dir,
    source: (ext = 'mp4') => path.join(dir, `source.${ext}`),
    audio: path.join(dir, 'audio.mp3'),
    shortsDir: path.join(dir, 'shorts'),
    thumbsDir: path.join(dir, 'thumbs'),
    subsDir: path.join(dir, 'subs'),
    analysis: path.join(dir, 'analysis.json'),
  };
};

export function ensureProjectDirs(projectId) {
  const p = mediaPaths(projectId);
  for (const dir of [p.dir, p.shortsDir, p.thumbsDir, p.subsDir]) fs.mkdirSync(dir, { recursive: true });
  return p;
}

export function sourceFileFor(project) {
  if (!project?.source_path) return null;
  const abs = path.resolve(project.source_path);
  if (!abs.startsWith(path.resolve(MEDIA_DIR))) return null;
  return fs.existsSync(abs) ? abs : null;
}

const fmtTime = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function transcriptInRange(transcript, start, end) {
  return (transcript || [])
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordsFrom(text, limit = 6) {
  const counts = new Map();
  for (const word of String(text).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

/* ------------------------------------------------------------------ *
 * Stage 1: real analysis of the media file
 * ------------------------------------------------------------------ */

export async function analyzeMedia(project, ctx) {
  const file = sourceFileFor(project);
  if (!file) throw new Error('No authorized media file is attached to this project.');

  ctx.report(6, 'probe', 'Reading media container and stream metadata');
  const info = await probe(file);
  if (!info.duration || info.duration < 3) throw new Error('The source video is shorter than 3 seconds.');
  db.prepare(
    'UPDATE projects SET duration=?, width=?, height=?, fps=?, has_audio=?, size_bytes=?, updated_at=? WHERE id=?',
  ).run(info.duration, info.width, info.height, info.fps, info.hasAudio ? 1 : 0, info.sizeBytes, now(), project.id);

  const paths = ensureProjectDirs(project.id);
  let energy = [];
  let scenes = [];
  let silence = [];
  let loudness = { lufs: null, lra: null };
  let transcript = null;
  let transcriptSource = null;

  if (info.hasAudio) {
    ctx.report(14, 'audio', 'Extracting audio track for speech analysis');
    await extractAudio(file, paths.audio, { tag: ctx.tag });

    ctx.report(24, 'scenes', 'Detecting real scene changes');
    try {
      scenes = await detectScenes(file, { tag: ctx.tag });
    } catch {
      scenes = [];
    }

    ctx.report(32, 'energy', 'Measuring speech energy and silence');
    try {
      energy = await audioEnergy(paths.audio, { tag: ctx.tag });
    } catch {
      energy = [];
    }
    try {
      silence = await detectSilence(paths.audio, { tag: ctx.tag });
    } catch {
      silence = [];
    }
    try {
      loudness = await measureLoudness(paths.audio, { tag: ctx.tag });
    } catch {
      loudness = { lufs: null, lra: null };
    }

    if (aiConfigured()) {
      ctx.report(38, 'transcribe', 'Transcribing speech with Gemini');
      const segments = [];
      const chunks = Math.ceil(info.duration / CHUNK_SECONDS);
      for (let i = 0; i < chunks; i += 1) {
        ctx.checkpoint();
        const start = i * CHUNK_SECONDS;
        const length = Math.min(CHUNK_SECONDS, info.duration - start);
        if (length < 1) continue;
        const chunkPath = path.join(paths.dir, `chunk-${i}.mp3`);
        await sliceAudio(paths.audio, chunkPath, start, length, { tag: ctx.tag });
        try {
          const result = await transcribeChunk(chunkPath, { language: project.language || 'en', chunkStart: start });
          segments.push(...result.segments);
        } catch (err) {
          ctx.log(`Transcription chunk ${i + 1}/${chunks} failed: ${err.message}`, 'warn');
        } finally {
          fs.rmSync(chunkPath, { force: true });
        }
        ctx.report(38 + Math.round(((i + 1) / chunks) * 12), 'transcribe', `Transcribed ${i + 1}/${chunks} audio chunks`);
      }
      if (segments.length) {
        transcript = segments.sort((a, b) => a.start - b.start);
        transcriptSource = 'gemini';
      }
    } else {
      ctx.log('GEMINI_API_KEY not configured — skipping speech transcription and AI captions.', 'warn');
    }
  }

  const analysis = {
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: Number(info.fps.toFixed(2)),
    hasAudio: info.hasAudio,
    scenes: scenes.slice(0, 500),
    sceneCount: scenes.length,
    energy: energy.filter((_, i) => i % 2 === 0).slice(0, 1500),
    silence: silence.slice(0, 300),
    loudness,
    transcriptSegments: transcript ? transcript.length : 0,
    transcriptSource,
    analyzedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.analysis, JSON.stringify(analysis, null, 2));

  db.prepare(
    'UPDATE projects SET transcript=?, transcript_source=?, analysis=?, status=?, stage=?, progress=?, updated_at=? WHERE id=?',
  ).run(
    transcript ? JSON.stringify(transcript) : null,
    transcriptSource,
    JSON.stringify(analysis),
    'analyzed',
    'analysis complete',
    50,
    now(),
    project.id,
  );

  return { info, analysis, transcript, energy, scenes, silence, loudness, file, paths };
}

/* ------------------------------------------------------------------ *
 * Stage 2: moment selection (AI when available, evidence-based fallback)
 * ------------------------------------------------------------------ */

export function heuristicMoments({ duration, transcript, energy, scenes, silence, count, minDuration, maxDuration }) {
  const step = 1;
  const window = Math.max(minDuration, Math.min(maxDuration, 30));
  const energyMap = new Map((energy || []).map((e) => [Math.round(e.t), e.rms]));
  const sceneSet = new Set((scenes || []).map((t) => Math.round(t)));
  const candidates = [];

  for (let start = 0; start + window <= duration; start += step) {
    const end = start + window;
    let sum = 0;
    let samples = 0;
    let sceneHits = 0;
    for (let t = start; t < end; t += 1) {
      const rms = energyMap.get(Math.round(t));
      if (rms != null) {
        sum += Math.max(-60, rms);
        samples += 1;
      }
      if (sceneSet.has(Math.round(t))) sceneHits += 1;
    }
    const avg = samples ? sum / samples : -45;
    const speech = transcriptInRange(transcript, start, end);
    const words = speech ? speech.split(/\s+/).length : 0;
    const speechDensity = Math.min(1, words / (window * 2.2));
    const score = (avg + 60) * 1.6 + sceneHits * 3 + speechDensity * 28;
    if (speechDensity < 0.05 && samples && avg < -45) continue;
    candidates.push({ start, end, score, speech, sceneHits, avg, speechDensity });
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const candidate of candidates) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => Math.min(c.end, candidate.end) - Math.max(c.start, candidate.start) > 1)) continue;
    // Snap edges to a nearby scene change or silence gap for a cleaner cut.
    let start = candidate.start;
    let end = candidate.end;
    const snap = (value, list) => {
      let best = value;
      let bestDelta = 2.5;
      for (const t of list) {
        const delta = Math.abs(t - value);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = t;
        }
      }
      return best;
    };
    start = snap(start, scenes || []);
    end = snap(end, scenes || []);
    for (const gap of silence || []) {
      if (Math.abs(gap.end - start) < 2 && gap.end < end - 8) start = gap.end;
      if (Math.abs(gap.start - end) < 2 && gap.start > start + 8) end = gap.start;
    }
    start = Math.max(0, Math.min(start, duration - 5));
    end = Math.min(duration, Math.max(end, start + 6));
    chosen.push({ ...candidate, start: Number(start.toFixed(2)), end: Number(end.toFixed(2)) });
  }

  return chosen.map((c, i) => {
    const words = c.speech ? c.speech.split(/\s+/) : [];
    const title = words.length ? words.slice(0, 9).join(' ') : `Highlight ${i + 1} at ${fmtTime(c.start)}`;
    const lower = c.speech.toLowerCase();
    const emotion = /(love|heart|family|miss|cry|tears|grateful)/.test(lower)
      ? 'emotional'
      : /(funny|laugh|joke|hilarious)/.test(lower)
        ? 'funny'
        : /(learn|how|why|tip|step|because)/.test(lower)
          ? 'educational'
          : /(never|impossible|fight|risk|lost|war|danger)/.test(lower)
            ? 'dramatic'
            : /(can|will|start|change|dream|believe|future)/.test(lower)
              ? 'motivational'
              : 'highlight';
    return {
      start: c.start,
      end: c.end,
      title: title.length > 2 ? title.charAt(0).toUpperCase() + title.slice(1) : `Highlight ${i + 1}`,
      hook: words.slice(0, 6).join(' '),
      emotion,
      score: Math.round(Math.max(20, Math.min(98, c.score))),
      reason: c.speech
        ? `Selected from measured audio energy (${c.avg.toFixed(0)} dB avg), ${c.sceneHits} scene change(s) and speech density.`
        : `Selected from measured audio energy (${c.avg.toFixed(0)} dB avg) and ${c.sceneHits} scene change(s); no transcript was available for this source.`,
      keywords: keywordsFrom(c.speech),
    };
  });
}

export async function chooseMoments({ project, analysis, transcript, count, prefs }) {
  const minDuration = Math.max(10, Number(prefs.shortDuration) - 12);
  const maxDuration = Math.min(75, Number(prefs.shortDuration) + 15);
  if (aiConfigured() && transcript && transcript.length) {
    try {
      const moments = await selectMoments({
        duration: analysis.duration,
        transcript,
        scenes: analysis.scenes,
        energy: analysis.energy,
        count,
        minDuration,
        maxDuration,
        language: prefs.language || 'en',
      });
      return { moments: moments.slice(0, count), source: 'gemini' };
    } catch (err) {
      return {
        moments: heuristicMoments({ ...analysis, transcript, count, minDuration, maxDuration }),
        source: 'heuristic',
        warning: `Gemini moment selection failed: ${err.message}`,
      };
    }
  }
  return {
    moments: heuristicMoments({ ...analysis, transcript, count, minDuration, maxDuration }),
    source: transcript ? 'heuristic' : 'heuristic-no-transcript',
  };
}

/* ------------------------------------------------------------------ *
 * Stage 3: metadata + director, grounded in the clip transcript
 * ------------------------------------------------------------------ */

function derivedSeo({ clipText, projectTitle, start, end, index, prefs }) {
  const words = clipText.split(/\s+/).filter(Boolean);
  const keywords = keywordsFrom(clipText, 8);
  const baseTitle = words.length
    ? words.slice(0, 12).join(' ').replace(/[.,!?]+$/, '')
    : `${projectTitle} — ${fmtTime(start)}–${fmtTime(end)} highlight`;
  const title = `${baseTitle.charAt(0).toUpperCase()}${baseTitle.slice(1)}`.slice(0, 92);
  const hashtags = ['#shorts', ...keywords.slice(0, 4).map((k) => `#${k.replace(/[^a-z0-9]/g, '')}`)].filter(Boolean);
  return {
    title,
    description: clipText
      ? `${clipText.slice(0, 400)}\n\n${hashtags.join(' ')}`
      : `Clip ${index} from ${projectTitle} (${fmtTime(start)}–${fmtTime(end)}). Add your own description before publishing.\n\n${hashtags.join(' ')}`,
    hashtags,
    keywords: keywords.length ? keywords : [projectTitle],
    thumbnailText: (words.slice(0, 4).join(' ') || title).slice(0, 40),
    categoryId: prefs.category || '22',
    pinnedComment: words.length ? `Which part hit hardest? ${hashtags[1] || ''}`.trim() : '',
    visibility: 'private',
  };
}

function ruleDirector({ duration, hasCaptions, emotion }) {
  const recommendations = [
    {
      at: 0,
      type: 'hook',
      label: 'Open on the strongest line',
      detail: 'Keep the hook text on screen for the first 3 seconds to stop the scroll.',
      autoApply: true,
      applied: false,
    },
    {
      at: 1.5,
      type: 'zoom',
      label: 'Slow push-in',
      detail: 'A 10% gradual zoom keeps attention on the subject during the opening statement.',
      autoApply: true,
      applied: false,
    },
  ];
  if (hasCaptions) {
    recommendations.push({
      at: 0,
      type: 'captions',
      label: 'Bold highlight captions',
      detail: 'Word-level captions with highlighted keywords stay readable on mobile.',
      autoApply: true,
      applied: false,
    });
  }
  recommendations.push(
    {
      at: Math.max(0, duration - 1.2),
      type: 'fade',
      label: 'Clean fade out',
      detail: 'Fade the last 0.4s so the loop feels intentional.',
      autoApply: true,
      applied: false,
    },
    {
      at: Math.max(0, duration * 0.5),
      type: 'grade',
      label: 'Light cinematic grade',
      detail: `Boost saturation slightly for a ${emotion || 'punchy'} look.`,
      autoApply: true,
      applied: false,
    },
    {
      at: 0,
      type: 'music',
      label: 'Background music suggestion',
      detail: 'Add a licensed track at -18 LUFS under the voice; music is not added automatically to avoid unlicensed audio.',
      autoApply: false,
      applied: false,
    },
  );
  return recommendations;
}

/* ------------------------------------------------------------------ *
 * Stage 4: render a Short
 * ------------------------------------------------------------------ */

export async function renderOneShort({ project, short, transcript, prefs, ctx, file, info, effects = [], regenerate = false }) {
  const paths = ensureProjectDirs(project.id);
  const outFile = path.join(paths.shortsDir, `${short.id}.mp4`);
  const thumbFile = path.join(paths.thumbsDir, `${short.id}.jpg`);
  const subFile = path.join(paths.subsDir, `${short.id}.ass`);

  const clipSegments = (transcript || []).filter((s) => s.end > short.start_sec && s.start < short.end_sec);
  const clipText = clipSegments.map((s) => s.text).join(' ').trim();

  let subtitlePath = null;
  if (clipSegments.length && prefs.captionStyle !== 'none') {
    fs.writeFileSync(subFile, buildAss(clipSegments, short.start_sec, short.end_sec, { style: prefs.captionStyle }), 'utf8');
    subtitlePath = subFile;
  }

  const appliedEffects = [...new Set([...(effects || []), ...(prefs.captionStyle !== 'none' ? [] : [])])];
  const started = Date.now();
  const render = await renderShort({
    source: file,
    output: outFile,
    start: short.start_sec,
    end: short.end_sec,
    hasAudio: Boolean(info?.hasAudio),
    captions: subtitlePath,
    captionStyle: prefs.captionStyle,
    hook: short.hook,
    watermark: prefs.watermark,
    quality: prefs.quality,
    effects: appliedEffects,
    tag: ctx.tag,
    onProgress: (pct) => ctx.report(65 + Math.round(pct * 0.22), 'render', `Rendering ${short.id.slice(-6)}: ${pct}%`),
  });

  let thumbAt = short.start_sec + Math.min(2, (short.end_sec - short.start_sec) / 3);
  if (aiConfigured()) {
    try {
      const frames = await frameSamples(file, [
        short.start_sec + 0.5,
        short.start_sec + (short.end_sec - short.start_sec) / 2,
        Math.max(short.start_sec, short.end_sec - 0.5),
      ], { tag: ctx.tag });
      const vision = await inspectClip({ frames, transcriptText: clipText.slice(0, 1200), duration: render.duration });
      if (vision && Number.isFinite(Number(vision.bestThumbnailAt))) {
        thumbAt = short.start_sec + Math.max(0, Math.min(render.duration - 0.2, Number(vision.bestThumbnailAt)));
      }
    } catch (err) {
      ctx.log(`Vision inspection skipped: ${err.message}`, 'warn');
    }
  }
  await renderThumbnail({
    source: file,
    atSeconds: thumbAt,
    output: thumbFile,
    text: short.thumbnail_text || short.hook || '',
    tag: ctx.tag,
    quality: prefs.quality,
  });

  db.prepare(
    `UPDATE shorts SET file_path=?, thumb_path=?, subtitle_path=?, duration=?, render_ms=?, caption_style=?, updated_at=? WHERE id=?`,
  ).run(
    outFile,
    thumbFile,
    subtitlePath,
    Number((short.end_sec - short.start_sec).toFixed(2)),
    Date.now() - started,
    prefs.captionStyle,
    now(),
    short.id,
  );

  if (!regenerate) {
    ctx.report(90, 'director', 'Reviewing the rendered clip as director');
    let recommendations = null;
    if (aiConfigured()) {
      try {
        recommendations = await directClip({
          clipText,
          duration: render.duration,
          emotion: short.emotion,
          captionStyle: prefs.captionStyle,
        });
      } catch (err) {
        ctx.log(`AI director unavailable: ${err.message}`, 'warn');
      }
    }
    if (!recommendations || !recommendations.length) {
      recommendations = ruleDirector({ duration: render.duration, hasCaptions: Boolean(subtitlePath), emotion: short.emotion });
    }
    db.prepare('UPDATE shorts SET director=?, updated_at=? WHERE id=?').run(JSON.stringify(recommendations), now(), short.id);
  }

  return { render, clipText, clipSegments, subtitlePath, thumbFile, outFile };
}

/* ------------------------------------------------------------------ *
 * Full autopilot workflow
 * ------------------------------------------------------------------ */

export async function runAutopilot({ project, count, ctx }) {
  const prefs = getPreferences();
  const target = Math.max(1, Math.min(10, Number(count) || Number(prefs.shortsPerVideo) || 5));

  ctx.report(3, 'validate', 'Validating authorized media source');
  if (!sourceFileFor(project)) {
    db.prepare('UPDATE projects SET status=?, stage=?, error=?, updated_at=? WHERE id=?').run(
      'awaiting_source',
      'awaiting media',
      'This project was created from a YouTube link. Upload the original file (or connect the channel that owns it) so the agent can render clips legally.',
      now(),
      project.id,
    );
    throw new Error(
      'No renderable media file. YouTube URLs do not grant download rights — upload the original video or provide an authorized direct media URL.',
    );
  }

  const analysisResult = await analyzeMedia(project, ctx);
  const { analysis, transcript, info, file, energy, scenes, silence } = analysisResult;

  ctx.report(52, 'moments', `Selecting the ${target} strongest moments`);
  const selection = await chooseMoments({ project, analysis, transcript, count: target, prefs });
  if (selection.warning) ctx.log(selection.warning, 'warn');
  if (!selection.moments.length) throw new Error('No usable moments were found in this video.');

  db.prepare('DELETE FROM shorts WHERE project_id = ?').run(project.id);
  db.prepare('UPDATE projects SET status=?, stage=?, progress=?, short_count=?, updated_at=? WHERE id=?').run(
    'processing',
    'generating shorts',
    55,
    selection.moments.length,
    now(),
    project.id,
  );

  const created = [];
  for (let i = 0; i < selection.moments.length; i += 1) {
    ctx.checkpoint();
    const moment = selection.moments[i];
    const id = uid('sh');
    const short = {
      id,
      project_id: project.id,
      idx: i + 1,
      start_sec: moment.start,
      end_sec: moment.end,
      hook: moment.hook || '',
      emotion: moment.emotion,
      score: moment.score,
      reason: moment.reason,
    };

    let seo;
    const clipText = transcriptInRange(transcript, moment.start, moment.end);
    if (aiConfigured()) {
      try {
        seo = await generateSeo({
          clipText,
          projectTitle: project.title,
          channelTitle: prefs.channelTitle || null,
          language: prefs.language || 'en',
          duration: moment.end - moment.start,
          category: prefs.category,
        });
        seo.source = 'gemini';
      } catch (err) {
        ctx.log(`SEO generation fell back to transcript derivation: ${err.message}`, 'warn');
        seo = { ...derivedSeo({ clipText, projectTitle: project.title, start: moment.start, end: moment.end, index: i + 1, prefs }), source: 'derived' };
      }
    } else {
      seo = { ...derivedSeo({ clipText, projectTitle: project.title, start: moment.start, end: moment.end, index: i + 1, prefs }), source: 'derived' };
    }

    const ts = now();
    db.prepare(
      `INSERT INTO shorts (id, project_id, idx, title, description, hashtags, keywords, pinned_comment, category,
        thumbnail_text, hook, start_sec, end_sec, score, emotion, reason, metadata_source, caption_style,
        status, visibility, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      project.id,
      i + 1,
      seo.title,
      seo.description,
      JSON.stringify(seo.hashtags || []),
      JSON.stringify(seo.keywords || []),
      seo.pinnedComment || '',
      seo.categoryId || prefs.category,
      seo.thumbnailText || '',
      moment.hook || '',
      moment.start,
      moment.end,
      moment.score,
      moment.emotion,
      moment.reason,
      seo.source,
      prefs.captionStyle,
      prefs.approvalMode === 'A' ? STATUS.DRAFT : STATUS.AWAITING_APPROVAL,
      seo.visibility || 'private',
      ts,
      ts,
    );

    const stored = getShort(id);
    ctx.report(58 + Math.round((i / selection.moments.length) * 34), 'render', `Rendering Short ${i + 1} of ${selection.moments.length}`);
    const result = await renderOneShort({ project, short: stored, transcript, prefs, ctx, file, info });
    created.push({ id, ...stored, clipText: result.clipText });
    ctx.log(`Short ${i + 1} rendered: ${path.basename(result.outFile)} (${result.render.bytes} bytes)`);
  }

  db.prepare('UPDATE projects SET status=?, stage=?, progress=?, short_count=?, error=NULL, updated_at=? WHERE id=?').run(
    'ready',
    'completed',
    100,
    created.length,
    now(),
    project.id,
  );

  notify(
    'success',
    `${created.length} Shorts ready`,
    `${project.title} — review and approve them before publishing.`,
    `/shorts?project=${project.id}`,
  );
  return { shorts: created, momentsSource: selection.source };
}

/* ------------------------------------------------------------------ *
 * Re-render with director changes
 * ------------------------------------------------------------------ */

export async function rerenderShort({ shortId, effects, ctx }) {
  const short = getShort(shortId);
  if (!short) throw new Error('Short not found');
  const project = getProject(short.project_id);
  const prefs = getPreferences();
  const file = sourceFileFor(project);
  if (!file) throw new Error('The source video for this project is no longer available.');
  const info = await probe(file);
  const transcript = project.transcript || [];
  const applied = Array.isArray(effects) && effects.length ? effects : parseJson(short.director_applied, []);
  ctx.report(60, 'render', 'Re-rendering with approved director changes');
  const result = await renderOneShort({ project, short, transcript, prefs, ctx, file, info, effects: applied, regenerate: true });
  db.prepare('UPDATE shorts SET director_applied=?, updated_at=? WHERE id=?').run(JSON.stringify(applied), now(), short.id);
  return { file: result.outFile, effects: applied };
}

export { shortRow };
