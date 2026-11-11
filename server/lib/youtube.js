import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, decryptSecret, encryptSecret, youtubeConfigured } from '../config.js';
import { db, getChannel, now, updateChannelTokens } from '../db.js';

const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

export function authUrl({ redirectUri, state }) {
  if (!youtubeConfigured()) throw new Error('YouTube OAuth is not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `${OAUTH_AUTH}?${params.toString()}`;
}

export function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state, secret) {
  if (!state || !String(state).includes('.')) return null;
  const [body, sig] = String(state).split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export async function exchangeCode({ code, redirectUri }) {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || 'Token exchange failed');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiry: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scopes: json.scope,
  };
}

export async function fetchChannelInfo(accessToken) {
  const res = await fetch(`${API}/channels?part=snippet,statistics,contentDetails&mine=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Could not read the YouTube channel');
  const item = json.items?.[0];
  if (!item) throw new Error('No YouTube channel is attached to this Google account.');
  return {
    channelId: item.id,
    title: item.snippet?.title,
    handle: item.snippet?.customUrl || null,
    thumbnail: item.snippet?.thumbnails?.default?.url || item.snippet?.thumbnails?.medium?.url || null,
    subscribers: Number(item.statistics?.subscriberCount || 0),
    videos: Number(item.statistics?.videoCount || 0),
  };
}

export async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(`${OAUTH_REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch {
    /* revocation is best effort */
  }
}

/** Refresh the stored access token when it is close to expiry. */
export async function getAccessToken() {
  const channel = getChannel();
  if (!channel) throw new Error('Connect a YouTube channel first.');
  const refreshToken = decryptSecret(channel.refresh_token);
  const accessToken = decryptSecret(channel.access_token);
  if (channel.token_expiry && channel.token_expiry > Date.now() + 60_000 && accessToken) return accessToken;
  if (!refreshToken) {
    if (accessToken) return accessToken;
    throw new Error('The YouTube connection expired. Please reconnect the channel.');
  }
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || 'Could not refresh the YouTube token');
  const expiry = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  updateChannelTokens(channel.channel_id, { accessToken: json.access_token, expiry });
  db.prepare('UPDATE channels SET access_token = ? WHERE channel_id = ?').run(encryptSecret(json.access_token), channel.channel_id);
  return json.access_token;
}

/** Verify a YouTube URL belongs to the connected channel before touching it. */
export async function fetchOwnedVideo(accessToken, videoId) {
  const res = await fetch(`${API}/videos?part=snippet,contentDetails,status&id=${encodeURIComponent(videoId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'YouTube API error');
  const item = json.items?.[0];
  if (!item) return null;
  return {
    videoId: item.id,
    channelId: item.snippet?.channelId,
    title: item.snippet?.title,
    description: item.snippet?.description,
    publishedAt: item.snippet?.publishedAt,
    duration: item.contentDetails?.duration,
    thumbnails: item.snippet?.thumbnails,
    privacyStatus: item.status?.privacyStatus,
  };
}

function parseSrt(srt) {
  const segments = [];
  const blocks = String(srt).replace(/\r/g, '').split('\n\n');
  const toSeconds = (stamp) => {
    const [hms, ms] = stamp.split(/[.,]/);
    const [h, m, s] = hms.split(':').map(Number);
    return h * 3600 + m * 60 + s + Number(ms || 0) / 1000;
  };
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [from, to] = timeLine.split('-->').map((s) => s.trim());
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    segments.push({ start: toSeconds(from), end: toSeconds(to), text });
  }
  return segments;
}

/** Download caption text for a video the user owns (authorized via OAuth). */
export async function fetchOwnedCaptions(accessToken, videoId) {
  const listRes = await fetch(`${API}/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const list = await listRes.json();
  if (!listRes.ok) return { segments: [], note: list.error?.message || 'Caption list unavailable' };
  const tracks = list.items || [];
  if (!tracks.length) return { segments: [], note: 'No caption track is available for this video.' };
  const preferred = tracks.find((t) => t.snippet?.language === 'en') || tracks[0];
  const capRes = await fetch(`${API}/captions/${preferred.id}?tfmt=srt`, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: 'follow',
  });
  if (!capRes.ok) return { segments: [], note: 'Caption download is not permitted for this track.' };
  const srt = await capRes.text();
  return { segments: parseSrt(srt), language: preferred.snippet?.language };
}

const CHUNK_SIZE = 8 * 1024 * 1024; // multiple of 256 KiB, required by the resumable protocol

async function initiateUpload({ accessToken, size, metadata }) {
  const res = await fetch(`${UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(size),
      'x-upload-content-type': 'video/mp4',
    },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`YouTube upload session failed (${res.status}): ${detail.slice(0, 400)}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new Error('YouTube did not return an upload session URL.');
  return location;
}

/**
 * Real resumable upload with byte-accurate progress.
 * Uses the official YouTube Data API v3 videos.insert endpoint.
 */
export async function uploadVideo({
  filePath,
  title,
  description,
  tags = [],
  categoryId = '22',
  privacyStatus = 'private',
  publishAt = null,
  onProgress = () => {},
  signal,
}) {
  if (!youtubeConfigured()) throw new Error('YouTube OAuth is not configured.');
  const accessToken = await getAccessToken();
  const size = fs.statSync(filePath).size;
  const metadata = {
    snippet: {
      title: String(title).slice(0, 100),
      description: String(description).slice(0, 4900),
      tags: tags.slice(0, 30),
      categoryId: String(categoryId || '22'),
    },
    status: {
      privacyStatus: publishAt ? 'private' : privacyStatus,
      selfDeclaredMadeForKids: false,
      ...(publishAt ? { publishAt: new Date(publishAt).toISOString() } : {}),
    },
  };

  const sessionUrl = await initiateUpload({ accessToken, size, metadata });
  let offset = 0;
  let result = null;

  while (offset < size) {
    if (signal?.aborted) throw new Error('Upload cancelled');
    const end = Math.min(offset + CHUNK_SIZE, size);
    const chunk = fs.createReadStream(filePath, { start: offset, end: end - 1 });
    const res = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(end - offset),
        'content-range': `bytes ${offset}-${end - 1}/${size}`,
        'content-type': 'video/mp4',
      },
      body: chunk,
      duplex: 'half',
      signal,
    });

    if (res.status === 308) {
      const range = res.headers.get('range');
      offset = range ? Number(range.split('-')[1]) + 1 : end;
      onProgress(Math.min(99, Math.round((offset / size) * 100)));
      continue;
    }
    if (res.status === 200 || res.status === 201) {
      result = await res.json();
      onProgress(100);
      break;
    }
    const detail = await res.text();
    throw new Error(`Upload failed (${res.status}): ${detail.slice(0, 400)}`);
  }

  if (!result?.id) throw new Error('YouTube did not confirm the uploaded video.');
  return {
    videoId: result.id,
    url: `https://youtube.com/shorts/${result.id}`,
    watchUrl: `https://www.youtube.com/watch?v=${result.id}`,
    status: result.status,
    publishedAt: result.snippet?.publishedAt || null,
  };
}

export async function fetchVideoStatus(videoId) {
  const accessToken = await getAccessToken();
  const res = await fetch(`${API}/videos?part=status,statistics,snippet&id=${encodeURIComponent(videoId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'YouTube API error');
  return json.items?.[0] || null;
}

export { youtubeConfigured };
