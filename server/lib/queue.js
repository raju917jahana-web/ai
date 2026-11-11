import { WORKER_CONCURRENCY } from '../config.js';
import { db, getJob, jobRow, logJob, notify, now, uid } from '../db.js';
import { killTag } from './ffmpeg.js';

export class CancelledError extends Error {
  constructor(message = 'Job cancelled') {
    super(message);
    this.cancelled = true;
  }
}

export class PausedError extends Error {
  constructor(message = 'Job paused') {
    super(message);
    this.paused = true;
  }
}

const handlers = new Map();
const active = new Map();
let timer = null;
let running = false;

export function registerHandler(type, handler) {
  handlers.set(type, handler);
}

export function enqueueJob({ type, projectId = null, shortId = null, payload = {}, maxAttempts = 2, runAt = null }) {
  if (!handlers.has(type)) throw new Error(`Unknown job type: ${type}`);
  const id = uid('job');
  const ts = now();
  db.prepare(
    `INSERT INTO jobs (id, project_id, short_id, type, status, stage, progress, message, attempts, max_attempts, payload, next_run_at, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'queued', 0, 'Waiting for a worker', 0, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, shortId, type, maxAttempts, JSON.stringify(payload || {}), runAt || ts, ts, ts);
  logJob(id, `Queued ${type} job`);
  scheduleSoon();
  return getJob(id);
}

function makeContext(job) {
  const id = job.id;
  const assertRunnable = () => {
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id);
    if (!row) throw new CancelledError('Job no longer exists');
    if (row.status === 'cancelled') throw new CancelledError();
    if (row.status === 'pause_requested') throw new PausedError();
  };
  return {
    jobId: id,
    tag: id,
    assertRunnable,
    checkpoint: assertRunnable,
    report(progress, stage, message) {
      const pct = Math.max(0, Math.min(100, Math.round(progress)));
      db.prepare('UPDATE jobs SET progress = ?, stage = ?, message = ?, updated_at = ? WHERE id = ?').run(
        pct,
        stage ? String(stage).slice(0, 80) : null,
        message ? String(message).slice(0, 300) : null,
        now(),
        id,
      );
      if (stage || message) logJob(id, `${stage ? `[${stage}] ` : ''}${message || ''}`.trim());
    },
    log(message, level = 'info') {
      logJob(id, message, level);
    },
  };
}

const claimNext = db.transaction(() => {
  const ts = now();
  const row = db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY created_at ASC LIMIT 1",
    )
    .get(ts);
  if (!row) return null;
  db.prepare("UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ? WHERE id = ?").run(
    ts,
    ts,
    row.id,
  );
  return getJob(row.id);
});

function finish(job, status, { result = null, error = null } = {}) {
  const ts = now();
  db.prepare(
    'UPDATE jobs SET status = ?, progress = ?, result = ?, error = ?, finished_at = ?, updated_at = ?, message = ? WHERE id = ?',
  ).run(
    status,
    status === 'completed' ? 100 : undefined ?? db.prepare('SELECT progress FROM jobs WHERE id = ?').get(job.id)?.progress ?? 0,
    result ? JSON.stringify(result) : null,
    error ? String(error).slice(0, 2000) : null,
    status === 'completed' || status === 'failed' || status === 'cancelled' ? ts : null,
    ts,
    status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : status,
    job.id,
  );
}

async function runJob(job) {
  const ctx = makeContext(job);
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
    ctx.report(job.progress || 1, job.stage || 'starting', `Starting ${job.type}`);
    const result = await handler({ job, payload: job.payload, ctx });
    const latest = db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id);
    if (latest?.status === 'cancelled') return;
    finish(job, 'completed', { result: result ?? {} });
    ctx.log(`${job.type} finished`);
  } catch (err) {
    killTag(job.id);
    const latest = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    if (err?.cancelled || latest?.status === 'cancelled') {
      db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ?, message = 'Cancelled by user' WHERE id = ?").run(
        now(),
        now(),
        job.id,
      );
      logJob(job.id, 'Job cancelled by user', 'warn');
      notify('warning', 'Task cancelled', job.type, `/tasks`);
      return;
    }
    if (err?.paused || latest?.status === 'pause_requested') {
      db.prepare("UPDATE jobs SET status = 'paused', updated_at = ?, message = 'Paused by user' WHERE id = ?").run(now(), job.id);
      logJob(job.id, 'Job paused at the last safe checkpoint', 'warn');
      return;
    }
    const attempts = latest?.attempts || 1;
    const maxAttempts = latest?.max_attempts || 2;
    logJob(job.id, `Error: ${err.message}`, 'error');
    if (attempts < maxAttempts) {
      const backoff = 4000 * attempts;
      db.prepare(
        "UPDATE jobs SET status = 'queued', message = ?, error = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      ).run(`Retrying after error: ${String(err.message).slice(0, 160)}`, String(err.message).slice(0, 2000), now() + backoff, now(), job.id);
      logJob(job.id, `Retry scheduled in ${Math.round(backoff / 1000)}s (attempt ${attempts + 1}/${maxAttempts})`, 'warn');
    } else {
      db.prepare(
        "UPDATE jobs SET status = 'failed', error = ?, message = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      ).run(String(err.message).slice(0, 2000), 'Failed', now(), now(), job.id);
      if (job.project_id) {
        db.prepare("UPDATE projects SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
          String(err.message).slice(0, 2000),
          now(),
          job.project_id,
        );
      }
      notify('error', 'Task failed', String(err.message).slice(0, 300), '/tasks');
    }
  }
}

function tick() {
  if (!running) return;
  while (active.size < WORKER_CONCURRENCY) {
    const job = claimNext();
    if (!job) break;
    const promise = runJob(job)
      .catch((err) => logJob(job.id, `Worker crash: ${err.message}`, 'error'))
      .finally(() => {
        active.delete(job.id);
        scheduleSoon();
      });
    active.set(job.id, promise);
  }
}

let soonTimer = null;
function scheduleSoon() {
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    tick();
  }, 60);
}

export function startWorker() {
  if (running) return;
  running = true;
  timer = setInterval(tick, 1000);
  tick();
}

export function stopWorker() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

export function activeJobCount() {
  return active.size;
}

export async function waitForIdle(timeoutMs = 30_000) {
  const started = Date.now();
  while (active.size > 0 || db.prepare("SELECT COUNT(*) c FROM jobs WHERE status = 'queued'").get().c > 0) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

export function pauseJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Job not found');
  if (job.status === 'queued') {
    db.prepare("UPDATE jobs SET status = 'paused', message = 'Paused by user', updated_at = ? WHERE id = ?").run(now(), id);
    logJob(id, 'Job paused before starting', 'warn');
  } else if (job.status === 'running') {
    db.prepare("UPDATE jobs SET status = 'pause_requested', message = 'Pausing at next checkpoint', updated_at = ? WHERE id = ?").run(now(), id);
    logJob(id, 'Pause requested — stopping at the next safe checkpoint', 'warn');
  } else {
    throw new Error(`Cannot pause a ${job.status} job`);
  }
  return getJob(id);
}

export function resumeJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Job not found');
  if (!['paused', 'failed'].includes(job.status)) throw new Error(`Cannot resume a ${job.status} job`);
  db.prepare("UPDATE jobs SET status = 'queued', message = 'Resumed by user', error = NULL, next_run_at = ?, updated_at = ? WHERE id = ?").run(
    now(),
    now(),
    id,
  );
  logJob(id, 'Job resumed by user');
  scheduleSoon();
  return getJob(id);
}

export function cancelJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Job not found');
  if (['completed', 'failed', 'cancelled'].includes(job.status)) throw new Error(`Job already ${job.status}`);
  db.prepare("UPDATE jobs SET status = 'cancelled', message = 'Cancelled by user', finished_at = ?, updated_at = ? WHERE id = ?").run(
    now(),
    now(),
    id,
  );
  killTag(id);
  logJob(id, 'Cancellation requested', 'warn');
  if (job.project_id) {
    db.prepare("UPDATE projects SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('processing','queued')").run(now(), job.project_id);
  }
  return getJob(id);
}

export function retryJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Job not found');
  if (!['failed', 'cancelled'].includes(job.status)) throw new Error(`Cannot retry a ${job.status} job`);
  db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, progress = 0, error = NULL, message = 'Retry queued', next_run_at = ?, updated_at = ? WHERE id = ?").run(
    now(),
    now(),
    id,
  );
  logJob(id, 'Job requeued by user');
  scheduleSoon();
  return getJob(id);
}

export { jobRow };
