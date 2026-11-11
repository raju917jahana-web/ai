import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR, PREFERENCE_DEFAULTS, STATUS } from './config.js';

export const db = new Database(path.join(DATA_DIR, 'autopilot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'youtube',
  channel_id TEXT NOT NULL,
  title TEXT,
  handle TEXT,
  thumbnail TEXT,
  subscribers INTEGER DEFAULT 0,
  videos INTEGER DEFAULT 0,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry INTEGER,
  scopes TEXT,
  connected_at INTEGER,
  UNIQUE(platform, channel_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  source_path TEXT,
  source_attestation INTEGER DEFAULT 0,
  source_note TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  stage TEXT,
  progress INTEGER DEFAULT 0,
  duration REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  has_audio INTEGER,
  size_bytes INTEGER,
  language TEXT,
  transcript TEXT,
  transcript_source TEXT,
  analysis TEXT,
  error TEXT,
  short_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shorts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  hashtags TEXT,
  keywords TEXT,
  pinned_comment TEXT,
  category TEXT,
  thumbnail_text TEXT,
  hook TEXT,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  duration REAL,
  score REAL,
  emotion TEXT,
  reason TEXT,
  file_path TEXT,
  thumb_path TEXT,
  subtitle_path TEXT,
  render_ms INTEGER,
  caption_style TEXT,
  director TEXT,
  director_applied TEXT,
  metadata_source TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT DEFAULT 'private',
  scheduled_at INTEGER,
  approved_at INTEGER,
  youtube_video_id TEXT,
  published_url TEXT,
  published_at INTEGER,
  upload_progress INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  short_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT,
  progress INTEGER DEFAULT 0,
  message TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 2,
  payload TEXT,
  result TEXT,
  error TEXT,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  actions TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_shorts_project ON shorts(project_id);
CREATE INDEX IF NOT EXISTS idx_shorts_status ON shorts(status);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id);
`);

export const now = () => Date.now();

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const projectRow = (row) =>
  row && {
    ...row,
    transcript: parseJson(row.transcript),
    analysis: parseJson(row.analysis),
    has_audio: Boolean(row.has_audio),
    source_attestation: Boolean(row.source_attestation),
  };

export const shortRow = (row) =>
  row && {
    ...row,
    hashtags: parseJson(row.hashtags, []),
    keywords: parseJson(row.keywords, []),
    director: parseJson(row.director, null),
    director_applied: parseJson(row.director_applied, []),
  };

export const jobRow = (row) =>
  row && {
    ...row,
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, null),
  };

export const getProject = (id) => projectRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
export const getShort = (id) => shortRow(db.prepare('SELECT * FROM shorts WHERE id = ?').get(id));
export const getJob = (id) => jobRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));

export function listProjects(limit = 50) {
  return db
    .prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(projectRow);
}

export function listShorts({ projectId, status, limit = 200 } = {}) {
  let sql = 'SELECT * FROM shorts';
  const where = [];
  const args = [];
  if (projectId) {
    where.push('project_id = ?');
    args.push(projectId);
  }
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit);
  return db.prepare(sql).all(...args).map(shortRow);
}

export function listJobs({ limit = 100, projectId, status } = {}) {
  let sql = 'SELECT * FROM jobs';
  const where = [];
  const args = [];
  if (projectId) {
    where.push('project_id = ?');
    args.push(projectId);
  }
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit);
  return db.prepare(sql).all(...args).map(jobRow);
}

export function jobLogs(jobId, limit = 200) {
  return db.prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY id ASC LIMIT ?').all(jobId, limit);
}

export function logJob(jobId, message, level = 'info') {
  db.prepare('INSERT INTO job_logs (job_id, level, message, created_at) VALUES (?, ?, ?, ?)').run(
    jobId,
    level,
    String(message).slice(0, 2000),
    now(),
  );
}

export function notify(kind, title, body = null, link = null) {
  db.prepare('INSERT INTO notifications (kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?)').run(
    kind,
    title,
    body,
    link,
    now(),
  );
}

export function getPreference(key) {
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key);
  return row ? row.value : PREFERENCE_DEFAULTS[key] ?? null;
}

export function getPreferences() {
  const out = { ...PREFERENCE_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM preferences').all()) out[row.key] = row.value;
  return out;
}

export function setPreference(key, value) {
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value == null ? '' : String(value), now());
}

export function setPreferences(patch = {}) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in PREFERENCE_DEFAULTS)) continue;
    setPreference(key, value);
  }
  return getPreferences();
}

export function listMemories(limit = 50) {
  return db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function addMemory(text, source = 'user') {
  db.prepare('INSERT INTO memories (text, source, created_at) VALUES (?, ?, ?)').run(String(text).slice(0, 1000), source, now());
}

export function deleteMemory(id) {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function listNotifications(limit = 30) {
  return db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function markNotificationsRead() {
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
}

export function listChat(limit = 100) {
  return db
    .prepare('SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?')
    .all(limit)
    .reverse()
    .map((m) => ({ ...m, actions: parseJson(m.actions, []) }));
}

export function addChat(role, content, actions = []) {
  const info = db
    .prepare('INSERT INTO chat_messages (role, content, actions, created_at) VALUES (?, ?, ?, ?)')
    .run(role, String(content).slice(0, 8000), JSON.stringify(actions || []), now());
  return info.lastInsertRowid;
}

export function dashboardStats() {
  const count = (sql, ...args) => db.prepare(sql).get(...args)?.c || 0;
  return {
    projects: count('SELECT COUNT(*) c FROM projects'),
    analyzed: count('SELECT COUNT(*) c FROM projects WHERE transcript IS NOT NULL OR analysis IS NOT NULL'),
    shorts: count('SELECT COUNT(*) c FROM shorts'),
    awaitingApproval: count('SELECT COUNT(*) c FROM shorts WHERE status = ?', STATUS.AWAITING_APPROVAL),
    approved: count('SELECT COUNT(*) c FROM shorts WHERE status IN (?, ?)', STATUS.APPROVED, STATUS.SCHEDULED),
    scheduled: count('SELECT COUNT(*) c FROM shorts WHERE status = ?', STATUS.SCHEDULED),
    published: count('SELECT COUNT(*) c FROM shorts WHERE status = ?', STATUS.PUBLISHED),
    failed: count('SELECT COUNT(*) c FROM shorts WHERE status = ?', STATUS.FAILED),
    failedJobs: count('SELECT COUNT(*) c FROM jobs WHERE status = ?', 'failed'),
    activeJobs: count('SELECT COUNT(*) c FROM jobs WHERE status IN (?, ?, ?)', 'queued', 'running', 'paused'),
    rendering: count('SELECT COUNT(*) c FROM shorts WHERE file_path IS NULL AND status != ?', STATUS.FAILED),
    totalDuration: db.prepare('SELECT COALESCE(SUM(duration), 0) d FROM shorts').get().d,
  };
}

export function getChannel() {
  return db.prepare("SELECT * FROM channels WHERE platform = 'youtube' ORDER BY connected_at DESC LIMIT 1").get();
}

export function saveChannel(channel) {
  const ts = now();
  db.prepare(
    `INSERT INTO channels (id, platform, channel_id, title, handle, thumbnail, subscribers, videos, access_token, refresh_token, token_expiry, scopes, connected_at)
     VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, channel_id) DO UPDATE SET
       title = excluded.title, handle = excluded.handle, thumbnail = excluded.thumbnail,
       subscribers = excluded.subscribers, videos = excluded.videos, access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, channels.refresh_token),
       token_expiry = excluded.token_expiry, scopes = excluded.scopes`,
  ).run(
    uid('ch'),
    channel.channelId,
    channel.title || null,
    channel.handle || null,
    channel.thumbnail || null,
    channel.subscribers || 0,
    channel.videos || 0,
    channel.accessToken || null,
    channel.refreshToken || null,
    channel.expiry || null,
    channel.scopes || null,
    ts,
  );
  return getChannel();
}

export function updateChannelTokens(channelId, { accessToken, refreshToken, expiry }) {
  db.prepare(
    'UPDATE channels SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expiry = ? WHERE channel_id = ?',
  ).run(accessToken, refreshToken || null, expiry, channelId);
}

export function disconnectChannel() {
  db.prepare("DELETE FROM channels WHERE platform = 'youtube'").run();
}

export function resetStaleJobs() {
  const ts = now();
  db.prepare(
    "UPDATE jobs SET status = 'queued', message = 'Requeued after restart', updated_at = ? WHERE status = 'running'",
  ).run(ts);
  db.prepare("UPDATE projects SET status = 'queued' WHERE status = 'processing'").run();
  return true;
}
