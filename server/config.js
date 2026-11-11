import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [DATA_DIR, MEDIA_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

const env = (key) => String(process.env[key] || '').trim();

export const PORT = Number(env('PORT') || 3000);
export const HOST = '0.0.0.0';

export const GEMINI_API_KEY = env('GEMINI_API_KEY') || env('GOOGLE_GENERATIVE_AI_API_KEY');
export const GEMINI_MODEL = env('GEMINI_MODEL') || 'gemini-2.5-flash';
export const GOOGLE_CLIENT_ID = env('YOUTUBE_CLIENT_ID') || env('GOOGLE_CLIENT_ID');
export const GOOGLE_CLIENT_SECRET = env('YOUTUBE_CLIENT_SECRET') || env('GOOGLE_CLIENT_SECRET');
export const PUBLIC_BASE_URL = (env('PUBLIC_BASE_URL') || env('APP_URL') || '').replace(/\/+$/, '');
export const APP_PASSWORD = env('APP_PASSWORD');
export const APP_SECRET =
  env('APP_SECRET') || crypto.createHash('sha256').update(`youtube-autopilot:${DATA_DIR}`).digest('hex');

export const WORKER_CONCURRENCY = Math.max(1, Math.min(4, Number(env('WORKER_CONCURRENCY') || 2)));
export const MAX_UPLOAD_BYTES = Math.max(16, Number(env('MAX_UPLOAD_MB') || 1024)) * 1024 * 1024;
export const MAX_SOURCE_SECONDS = Number(env('MAX_SOURCE_SECONDS') || 4 * 60 * 60);

export const FFMPEG = env('FFMPEG_PATH') || 'ffmpeg';
export const FFPROBE = env('FFPROBE_PATH') || 'ffprobe';

export const aiConfigured = () => Boolean(GEMINI_API_KEY);
export const youtubeConfigured = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

/** Absolute public base URL for OAuth redirects, honouring proxy headers. */
export function resolveBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

export function youtubeRedirectUri(req) {
  return `${resolveBaseUrl(req)}/api/youtube/callback`;
}

export function encryptionKey() {
  return crypto.scryptSync(APP_SECRET, 'youtube-autopilot-token-v1', 32);
}

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  try {
    const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const PREFERENCE_DEFAULTS = {
  shortDuration: '30',
  captionStyle: 'bold-highlight',
  language: 'en',
  aspectRatio: '9:16',
  uploadTime: '18:00',
  category: '22',
  watermark: '',
  quality: '1080p',
  approvalMode: 'B',
  shortsPerVideo: '5',
  autoPublish: 'false',
};

export const STATUS = {
  DRAFT: 'draft',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPROVED: 'approved',
  SCHEDULED: 'scheduled',
  PUBLISHED: 'published',
  FAILED: 'failed',
};
