import fs from 'node:fs';
import { GEMINI_API_KEY, GEMINI_MODEL, aiConfigured } from '../config.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const INLINE_LIMIT_BYTES = 14 * 1024 * 1024;

class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export { GeminiError };

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function request(body, { retries = 1, timeoutMs = 120_000 } = {}) {
  if (!aiConfigured()) throw new GeminiError('GEMINI_API_KEY is not configured', 0);
  const url = `${API_ROOT}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text();
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw new GeminiError(`Gemini request failed (${res.status}): ${detail.slice(0, 400)}`, res.status);
      }
      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || '').join('').trim();
      if (!text) {
        const block = json?.promptFeedback?.blockReason;
        throw new GeminiError(block ? `Gemini blocked the request: ${block}` : 'Gemini returned an empty response', 0);
      }
      return text;
    } catch (err) {
      if (err.name === 'AbortError' && attempt < retries) continue;
      if (attempt >= retries) throw err instanceof GeminiError ? err : new GeminiError(err.message, 0);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new GeminiError('Gemini request failed', 0);
}

function filePart(filePath, mimeType) {
  const bytes = fs.statSync(filePath).size;
  if (bytes > INLINE_LIMIT_BYTES) throw new GeminiError(`Audio chunk too large for inline analysis (${bytes} bytes)`, 0);
  return { inline_data: { mime_type: mimeType, data: fs.readFileSync(filePath).toString('base64') } };
}

const clampNum = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

/** Transcribe a chunk of audio with real timestamps (relative to the chunk). */
export async function transcribeChunk(audioPath, { language = 'en', chunkStart = 0 } = {}) {
  const text = await request(
    {
      contents: [
        {
          role: 'user',
          parts: [
            filePart(audioPath, 'audio/mpeg'),
            {
              text: `Transcribe this audio accurately. Language hint: ${language}.
Return ONLY JSON: {"segments":[{"start":0.0,"end":2.5,"text":"..."}],"language":"xx"}
Rules: split into natural phrases of 1-8 seconds, timestamps in seconds relative to the START OF THIS AUDIO FILE, no invented words, skip pure noise/music, keep the spoken words verbatim.`,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json', maxOutputTokens: 8192 },
    },
    { retries: 1, timeoutMs: 180_000 },
  );
  const parsed = extractJson(text) || {};
  const segments = (parsed.segments || [])
    .map((s) => ({
      start: Number((Number(s.start) || 0) + chunkStart).toFixed(2),
      end: Number((Number(s.end) || Number(s.start) + 2) + chunkStart).toFixed(2),
      text: String(s.text || '').trim(),
    }))
    .filter((s) => s.text && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  return { segments, language: parsed.language || language };
}

/** Pick the strongest moments from actual transcript + scene + energy evidence. */
export async function selectMoments({ duration, transcript, scenes, energy, count, minDuration, maxDuration, language = 'en' }) {
  const speech = (transcript || [])
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join('\n')
    .slice(0, 60_000);
  const sceneList = (scenes || []).slice(0, 120).map((t) => t.toFixed(1)).join(', ');
  const energyPeaks = [...(energy || [])]
    .sort((a, b) => b.rms - a.rms)
    .slice(0, 40)
    .map((e) => `${e.t.toFixed(1)}s:${e.rms.toFixed(0)}dB`)
    .join(', ');

  const prompt = `You are the moment-selection engine of an autonomous YouTube Shorts agent.
Video duration: ${duration.toFixed(1)} seconds. Language: ${language}.
Scene-change timestamps: ${sceneList || 'not available'}
Loudest audio moments: ${energyPeaks || 'not available'}
Transcript with timestamps:
${speech || '(no transcript available)'}

Select the ${count} best self-contained moments for vertical Shorts.
Requirements:
- Each clip ${minDuration}-${maxDuration} seconds, start and end on real timestamps inside 0..${duration.toFixed(1)}.
- No overlapping clips. Strong opening hook within the first 2 seconds, clean ending.
- Prefer emotional, funny, educational, dramatic or motivational peaks that stand alone without context.
- Base every timestamp strictly on the evidence above. Never invent content.
Return ONLY JSON:
{"moments":[{"start":0,"end":30,"title":"short punchy title","hook":"on-screen hook text","emotion":"funny|emotional|educational|dramatic|motivational","score":0-100,"reason":"why this moment works, referencing the transcript","keywords":["word"]}]}`;

  const text = await request(
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, responseMimeType: 'application/json', maxOutputTokens: 4096 },
    },
    { retries: 1 },
  );
  const parsed = extractJson(text) || {};
  const moments = (parsed.moments || [])
    .map((m) => ({
      start: clampNum(m.start, 0, duration),
      end: clampNum(m.end, 0, duration),
      title: String(m.title || '').slice(0, 100),
      hook: String(m.hook || '').slice(0, 60),
      emotion: String(m.emotion || 'highlight').slice(0, 20),
      score: clampNum(m.score, 1, 100),
      reason: String(m.reason || '').slice(0, 400),
      keywords: Array.isArray(m.keywords) ? m.keywords.slice(0, 8).map(String) : [],
    }))
    .filter((m) => m.end - m.start >= Math.min(6, minDuration * 0.5));
  if (!moments.length) throw new GeminiError('Gemini returned no usable moments', 0);
  return moments;
}

/** Vision check of the rendered clip: confirms framing/subject and suggests a thumbnail frame. */
export async function inspectClip({ frames, transcriptText, duration }) {
  const parts = [{ text: `You are a video editor inspecting a vertical Short (${duration.toFixed(1)}s). Frames are sampled in order.
Transcript: ${transcriptText || '(none)'}
Return ONLY JSON: {"subject":"main subject","bestThumbnailAt":0-${duration.toFixed(1)},"framingNote":"short note","energy":"calm|medium|high"}` }];
  for (const frame of frames) parts.push({ inline_data: { mime_type: 'image/jpeg', data: frame.base64 } });
  const text = await request(
    {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 512 },
    },
    { retries: 0, timeoutMs: 60_000 },
  );
  return extractJson(text) || null;
}

/** SEO metadata grounded in the real clip transcript. */
export async function generateSeo({ clipText, projectTitle, channelTitle, language = 'en', duration, category }) {
  const prompt = `You write YouTube Shorts metadata. Ground everything in the transcript below — never mislead.
Channel: ${channelTitle || 'the creator'}
Source video: ${projectTitle}
Clip duration: ${duration.toFixed(1)}s. Language: ${language}. Category id hint: ${category}.
Transcript of this clip:
${clipText || '(no speech detected in this clip)'}

Return ONLY JSON:
{"title":"<=90 chars, accurate, curiosity without clickbait lies","description":"120-500 chars, 1-2 sentences, line breaks allowed, ends with 3-6 hashtags","hashtags":["#tag"],"keywords":["search phrase"],"thumbnailText":"<=40 chars","categoryId":"22","pinnedComment":"a genuine engagement question","visibility":"private"}
Hashtags must be relevant and <=8. Do not promise anything the clip does not contain.`;
  const text = await request(
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, responseMimeType: 'application/json', maxOutputTokens: 1024 },
    },
    { retries: 1 },
  );
  const parsed = extractJson(text);
  if (!parsed || !parsed.title) throw new GeminiError('Gemini returned no SEO metadata', 0);
  return {
    title: String(parsed.title).slice(0, 100),
    description: String(parsed.description || '').slice(0, 4000),
    hashtags: (parsed.hashtags || []).slice(0, 8).map((h) => (String(h).startsWith('#') ? String(h) : `#${h}`)),
    keywords: (parsed.keywords || []).slice(0, 15).map(String),
    thumbnailText: String(parsed.thumbnailText || parsed.title || '').slice(0, 40),
    categoryId: String(parsed.categoryId || category || '22'),
    pinnedComment: String(parsed.pinnedComment || '').slice(0, 500),
  };
}

/** Director pass: timestamped editing recommendations for a generated clip. */
export async function directClip({ clipText, duration, emotion, captionStyle }) {
  const prompt = `You are an AI video director reviewing a ${duration.toFixed(1)}s vertical Short (emotion: ${emotion}, caption style: ${captionStyle}).
Transcript: ${clipText || '(no speech)'}
Recommend concrete edits with timestamps inside 0-${duration.toFixed(1)}.
Allowed effect types that can be applied automatically: zoom, grade, fade, captions, hook.
Return ONLY JSON:
{"recommendations":[{"at":0,"type":"zoom|grade|fade|captions|hook|transition|music|sound|slowmo|color","label":"short label","detail":"what to do and why","autoApply":true}]}
Give 4-7 recommendations. Keep it practical.`;
  const text = await request(
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, responseMimeType: 'application/json', maxOutputTokens: 1200 },
    },
    { retries: 1 },
  );
  const parsed = extractJson(text) || {};
  return (parsed.recommendations || []).slice(0, 10).map((r) => ({
    at: clampNum(r.at, 0, duration),
    type: String(r.type || 'effect').slice(0, 20),
    label: String(r.label || r.type || 'Edit').slice(0, 80),
    detail: String(r.detail || '').slice(0, 300),
    autoApply: ['zoom', 'grade', 'fade', 'captions', 'hook'].includes(String(r.type)),
    applied: false,
  }));
}

/** Natural-language command understanding for the chat command center. */
export async function parseCommand({ message, context }) {
  const prompt = `You are the command parser for an autonomous YouTube Shorts agent.
Available intents:
- create_project: {sourceUrl?, count?, projectId?} — start the full autopilot workflow
- make_shorts: {projectId?, count?} — generate more Shorts from an analyzed project
- generate_seo: {shortId?}
- list_approvals: {}
- approve_short: {shortId}
- publish_short: {shortId, visibility?}
- schedule_short: {shortId, when?}
- list_tasks: {}
- project_status: {projectId?}
- set_preference: {key, value}
- set_mode: {mode} (A, B or C)
- find_moments: {emotion?, count?}
- cancel_job: {jobId?}
- connect_youtube: {}
- help: {}
Context (current workspace):
${JSON.stringify(context).slice(0, 4000)}
User message: "${String(message).slice(0, 1000)}"
Return ONLY JSON: {"intent":"...","params":{},"reply":"one short sentence describing what you will do"}`;
  const text = await request(
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json', maxOutputTokens: 512 },
    },
    { retries: 0, timeoutMs: 45_000 },
  );
  return extractJson(text);
}

export { aiConfigured };
