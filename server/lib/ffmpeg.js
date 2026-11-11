import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { FFMPEG, FFPROBE } from '../config.js';

/** Live ffmpeg/ffprobe processes, so a cancelled job can kill its children. */
const running = new Map();

export function killTag(tag) {
  let killed = 0;
  for (const [pid, entry] of running.entries()) {
    if (tag && entry.tag !== tag) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/**
 * Run an ffmpeg/ffprobe binary and capture stdout/stderr.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function runFF(bin, args, { tag = null, onStderr = null, onStdout = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (tag) running.set(child.pid, { tag, child });
    let stdout = '';
    let stderr = '';
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* noop */
            }
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
      if (onStdout) onStdout(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      if (onStderr) onStderr(text);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      running.delete(child.pid);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      running.delete(child.pid);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${bin === FFMPEG ? 'ffmpeg' : 'ffprobe'} exited with code ${code}: ${tail(stderr)}`));
    });
  });
}

const tail = (text, n = 700) => String(text || '').trim().split('\n').slice(-6).join(' | ').slice(-n);

const parseRate = (rate) => {
  if (!rate || typeof rate !== 'string') return 0;
  const [num, den] = rate.split('/').map(Number);
  if (!den) return Number(num) || 0;
  return num / den;
};

export async function probe(file) {
  const { stdout } = await runFF(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream found in this file.');
  return {
    duration: Number(info.format?.duration || video.duration || 0),
    sizeBytes: Number(info.format?.size || 0),
    bitrate: Number(info.format?.bit_rate || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 0,
    videoCodec: video.codec_name || null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || null,
    audioChannels: Number(audio?.channels || 0),
    rotation: Number(video.tags?.rotate || 0),
  };
}

/** Extract a compact mono mp3 that Gemini can transcribe. */
export async function extractAudio(src, outPath, { tag } = {}) {
  await runFF(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', outPath],
    { tag },
  );
  const stat = fs.statSync(outPath);
  if (!stat.size) throw new Error('Audio extraction produced an empty file.');
  return { path: outPath, bytes: stat.size };
}

/** Cut a time range out of the audio, used to chunk long sources for transcription. */
export async function sliceAudio(src, outPath, start, duration, { tag } = {}) {
  await runFF(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(duration), '-i', src, '-c:a', 'libmp3lame', '-b:a', '48k', outPath],
    { tag },
  );
  return outPath;
}

/** Real scene-change detection (histogram based, not guessed). */
export async function detectScenes(src, { threshold = 0.32, tag } = {}) {
  const { stderr } = await runFF(
    FFMPEG,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      src,
      '-filter:v',
      `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
      '-an',
      '-f',
      'null',
      '-',
    ],
    { tag },
  );
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let match;
  while ((match = re.exec(stderr))) {
    const t = Number(match[1]);
    if (Number.isFinite(t) && (times.length === 0 || t - times[times.length - 1] > 0.35)) times.push(Number(t.toFixed(2)));
  }
  return times;
}

/** Loudness/energy timeline sampled every 0.5s — used for moment scoring and audio balancing. */
export async function audioEnergy(audioFile, { tag } = {}) {
  const { stdout } = await runFF(
    FFMPEG,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      audioFile,
      '-af',
      'asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f',
      'null',
      '-',
    ],
    { tag },
  );
  const points = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch) {
      current = Number(timeMatch[1]);
      continue;
    }
    const rmsMatch = line.match(/RMS_level=(-?[0-9.]+|-inf)/);
    if (rmsMatch && current != null) {
      const value = rmsMatch[1] === '-inf' ? -91 : Number(rmsMatch[1]);
      points.push({ t: Number(current.toFixed(2)), rms: value });
      current = null;
    }
  }
  return points;
}

export async function detectSilence(audioFile, { noise = '-32dB', minDuration = 0.7, tag } = {}) {
  const { stderr } = await runFF(
    FFMPEG,
    ['-hide_banner', '-nostats', '-i', audioFile, '-af', `silencedetect=noise=${noise}:d=${minDuration}`, '-f', 'null', '-'],
    { tag },
  );
  const gaps = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[0-9.]+)/);
    const e = line.match(/silence_end:\s*([0-9.]+)/);
    if (s) start = Number(s[1]);
    if (e && start != null) {
      gaps.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return gaps;
}

/** Integrated loudness (LUFS) for honest audio-balance reporting. */
export async function measureLoudness(audioFile, { tag } = {}) {
  const { stderr } = await runFF(
    FFMPEG,
    ['-hide_banner', '-nostats', '-i', audioFile, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { tag },
  );
  const summary = stderr.split('Summary:').pop() || '';
  const i = summary.match(/I:\s*(-?[0-9.]+)\s*LUFS/);
  const lra = summary.match(/LRA:\s*(-?[0-9.]+)\s*LU/);
  return { lufs: i ? Number(i[1]) : null, lra: lra ? Number(lra[1]) : null };
}

export async function extractFrame(src, atSeconds, outPath, { width = 1280, tag } = {}) {
  await runFF(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', outPath],
    { tag, timeoutMs: 60_000 },
  );
  return outPath;
}

/** Frame JPEGs (base64) for Gemini video understanding. */
export async function frameSamples(src, times, { tag } = {}) {
  const out = [];
  for (const t of times) {
    const file = `${src.replace(/\.[^.]+$/, '')}-frame-${Math.round(t)}.jpg`;
    try {
      await extractFrame(src, t, file, { width: 640, tag });
      out.push({ time: t, base64: fs.readFileSync(file).toString('base64'), path: file });
    } catch {
      /* a single failed frame must not fail the analysis */
    }
  }
  return out;
}

export async function writeSubtitleFile(assContent, filePath) {
  fs.writeFileSync(filePath, assContent, 'utf8');
  return filePath;
}
