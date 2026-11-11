/**
 * End-to-end functional check for the autonomous pipeline.
 *
 * 1. Generates a real 90s MP4 with FFmpeg (scenes + tone) so no external media is needed.
 * 2. Boots the API server against a throwaway data directory.
 * 3. Uploads the file, starts an autonomous run, waits for the worker.
 * 4. Verifies rendered 9:16 MP4s with ffprobe, metadata, approval gate and chat.
 *
 * Run with: npm run e2e
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3311);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-e2e-'));
const DATA = path.join(TMP, 'data');
const SAMPLE = path.join(TMP, 'sample.mp4');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

async function json(pathname, options) {
  const res = await fetch(`${BASE}${pathname}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });

  console.log('→ generating sample video with FFmpeg…');
  await exec('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=90',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=90',
    '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SAMPLE,
  ]);
  const sampleSize = fs.statSync(SAMPLE).size;
  check('sample video generated', sampleSize > 100_000, `${(sampleSize / 1024).toFixed(0)} KB`);

  const server = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: DATA,
      WORKER_CONCURRENCY: '2',
      APP_PASSWORD: '',
      GEMINI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));

  try {
    const up = await waitForServer();
    check('server boots and answers /api/health', up);
    if (!up) throw new Error(`server did not start:\n${serverLog.join('')}`);

    const state = await json('/api/state');
    check('dashboard state loads', state.status === 200 && !!state.body.stats, `projects=${state.body?.stats?.projects}`);

    // Preferences: fast 720p renders for the check.
    await json('/api/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quality: '720p', shortsPerVideo: '2', shortDuration: '20' }),
    });

    // Upload through the real multipart endpoint.
    const form = new FormData();
    form.append('video', new Blob([fs.readFileSync(SAMPLE)], { type: 'video/mp4' }), 'sample.mp4');
    form.append('attestation', 'true');
    form.append('title', 'E2E synthetic source');
    const created = await json('/api/projects', { method: 'POST', body: form });
    const project = created.body?.project;
    check('upload creates a project', (created.status === 200 || created.status === 201) && !!project, `${created.status} ${project?.id || ''}`);
    check('upload auto-starts the agent workflow', !!created.body?.job, created.body?.job?.id || '');

    const unauthorised = await json('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUrl: 'https://vimeo.com/123456' }),
    });
    check('non-YouTube URL source is rejected', unauthorised.status >= 400, unauthorised.body?.error || '');

    const run = await json(`/api/projects/${project.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 2 }),
    });
    check(
      'a second run reuses the in-flight task',
      run.status === 200 && !!run.body?.job && run.body.job.id === created.body?.job?.id,
      `${run.body?.job?.id || 'none'} vs ${created.body?.job?.id || 'none'}`,
    );

    // Poll the real queue.
    const deadline = Date.now() + 240_000;
    let finalState = null;
    let shorts = [];
    while (Date.now() < deadline) {
      await sleep(2500);
      finalState = (await json('/api/state')).body;
      const projectShorts = (finalState.shorts || []).filter((s) => s.project_id === project.id);
      shorts = projectShorts;
      const done = projectShorts.filter((s) => ['awaiting_approval', 'approved', 'published', 'failed'].includes(s.status)).length;
      const job = (finalState.jobs || []).find((j) => j.project_id === project.id && j.type === 'autopilot');
      if (done >= 1 && (!job || ['completed', 'failed', 'cancelled'].includes(job.status))) break;
      if (job && job.status === 'failed') break;
    }

    const job = (finalState.jobs || []).find((j) => j.project_id === project.id && j.type === 'autopilot');
    check('autopilot task reached a terminal state', !!job && ['completed', 'failed'].includes(job.status), job ? `${job.status} · ${job.message || ''}` : 'no job');
    check('at least one Short rendered', shorts.length > 0, `${shorts.length} clips`);
    const idxs = new Set(shorts.map((s) => s.idx));
    check('no duplicate clips from concurrent runs', shorts.length === idxs.size, `${shorts.length} clips / ${idxs.size} distinct idx`);

    const rendered = shorts.filter((s) => s.status === 'awaiting_approval' || s.status === 'approved');
    check('clips await approval instead of auto-publishing', rendered.length > 0, rendered.map((s) => s.status).join(','));

    for (const s of rendered.slice(0, 2)) {
      const detail = await json(`/api/shorts/${s.id}`);
      const short = detail.body?.short || detail.body;
      const file = short?.file_path;
      const exists = file && fs.existsSync(file);
      let dims = '';
      if (exists) {
        const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-of', 'json', file]);
        const stream = JSON.parse(stdout).streams?.[0] || {};
        dims = `${stream.width}x${stream.height}`;
        check(`clip ${s.idx} renders a real 9:16 MP4`, stream.width === 720 && stream.height === 1280, dims);
        check(`clip ${s.idx} has duration`, Number(stream.duration) > 3, `${stream.duration}s`);
      } else {
        check(`clip ${s.idx} file exists`, false, String(file));
      }
      check(`clip ${s.idx} has SEO metadata`, !!short?.title && Array.isArray(short?.hashtags) && short.hashtags.length > 0, short?.title || '');
      check(`clip ${s.idx} has a thumbnail`, !!short?.thumb_path && fs.existsSync(short.thumb_path));
      check(`clip ${s.idx} metadata is labelled`, !!short?.metadata_source, short?.metadata_source || '');

      // Publishing must require explicit confirmation.
      const blocked = await json(`/api/shorts/${s.id}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'public', confirm: false }),
      });
      check(`clip ${s.idx} cannot publish without confirmation`, blocked.status >= 400, blocked.body?.error || '');

      const preview = await json(`/api/shorts/${s.id}/preview`);
      const p = preview.body?.preview || preview.body;
      check(`clip ${s.idx} publishing preview available`, preview.status === 200 && !!p?.title, p?.title || '');
    }

    // Approval + scheduling state.
    if (rendered[0]) {
      const approve = await json(`/api/shorts/${rendered[0].id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      check('approval endpoint records approval', approve.status === 200, JSON.stringify(approve.body).slice(0, 120));
    }

    // Chat command center against the real agent.
    const chat = await json('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Show me all videos waiting for approval' }),
    });
    check('chat command returns an agent reply', chat.status === 200 && !!chat.body?.reply, chat.body?.reply?.slice(0, 90) || '');

    const chat2 = await json('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Turn this long video into two YouTube Shorts and prepare them for my channel' }),
    });
    check('chat handles Short generation instructions', chat2.status === 200 && Array.isArray(chat2.body?.actions), chat2.body?.reply?.slice(0, 90) || '');

    const media = await fetch(`${BASE}/api/media/${project.id}/shorts/${rendered[0]?.id}.mp4`);
    check('rendered clip is served over HTTP', media.ok && Number(media.headers.get('content-length') || 0) > 10_000, `status ${media.status}`);
  } finally {
    server.kill('SIGKILL');
    await sleep(300);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Server log tail:\n' + serverLog.join('').slice(-3000));
    process.exitCode = 1;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('E2E crashed:', err.message);
  process.exitCode = 1;
});
