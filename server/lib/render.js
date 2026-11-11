import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG } from '../config.js';
import { runFF } from './ffmpeg.js';

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

export function findFont() {
  for (const candidate of FONT_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  return null;
}

const CAPTION_STYLES = {
  'bold-highlight': { fontSize: 66, primary: '&H00FFFFFF', highlight: '&H0000E5FF', outline: 5, bold: true },
  clean: { fontSize: 58, primary: '&H00FFFFFF', highlight: '&H00FFFFFF', outline: 3, bold: false },
  'yellow-pop': { fontSize: 70, primary: '&H0000FFFF', highlight: '&H00FFFFFF', outline: 5, bold: true },
  karaoke: { fontSize: 64, primary: '&H00FFFFFF', highlight: '&H000000FF', outline: 4, bold: true },
};

const assTime = (seconds) => {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};

const escapeAss = (text) => String(text).replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();

const STOPWORDS = new Set(
  'the a an and or but if then than that this these those you your yours we our us i me my he she it they them his her its of to in on for with at by from as is are was were be been being do does did not no so just very really about into over after before when while what which who how why can could should would will shall may might have has had here there'.split(
    ' ',
  ),
);

function keywordsIn(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 6);
}

function wrapLines(text, maxChars = 24, maxLines = 2) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line.trim());
  return lines;
}

/**
 * Build a real ASS subtitle track from transcript segments, shifted into clip time.
 * Only uses words that were actually transcribed.
 */
export function buildAss(segments, clipStart, clipEnd, { style = 'bold-highlight', fontSize, marginV = 300 } = {}) {
  const conf = CAPTION_STYLES[style] || CAPTION_STYLES['bold-highlight'];
  const size = fontSize || conf.fontSize;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,${size},${conf.primary},&H000000FF,&H00000000,&H96000000,${conf.bold ? -1 : 0},0,0,0,100,100,0,0,1,${conf.outline},2,2,70,70,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [];
  for (const seg of segments || []) {
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    const start = Math.max(seg.start, clipStart);
    const end = Math.min(seg.end, clipEnd);
    if (end - start < 0.25) continue;
    const text = escapeAss(seg.text);
    if (!text) continue;
    const keys = keywordsIn(text);
    const highlight = (line) => {
      if (!keys.length) return line;
      let out = line;
      for (const key of keys.slice(0, 2)) {
        out = out.replace(new RegExp(`\\b(${key})\\b`, 'gi'), `{\\c${conf.highlight}&}$1{\\c${conf.primary}&}`);
      }
      return out;
    };
    const lines = wrapLines(text);
    // Split long segments so captions stay in sync with speech rhythm.
    const chunks = Math.max(1, Math.min(lines.length, Math.ceil((end - start) / 2.6)));
    const per = (end - start) / chunks;
    for (let i = 0; i < chunks; i += 1) {
      const chunkText = chunks === 1 ? lines.join('\\N') : lines[Math.min(i, lines.length - 1)];
      if (!chunkText) continue;
      // The renderer seeks with -ss, so clip time starts at zero: subtract clipStart
      // or every caption would appear clipStart seconds late (and never at all for
      // clips taken from deep in a long video).
      const offset = start - clipStart;
      events.push(
        `Dialogue: 0,${assTime(offset + i * per)},${assTime(offset + (i + 1) * per)},Cap,,0,0,0,,{\\fad(80,80)}${highlight(chunkText)}`,
      );
    }
  }
  return `${header}${events.join('\n')}\n`;
}

function escapeFilterPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/([':])/g, '\\$1');
}

function escapeDrawText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\u2019")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}

/**
 * Render a real 9:16 MP4 with blurred background fill, burned captions,
 * hook overlay, loudness-normalised audio and optional director effects.
 */
export async function renderShort(options) {
  const {
    source,
    output,
    start,
    end,
    hasAudio = true,
    captions = null,
    captionStyle = 'bold-highlight',
    hook = null,
    watermark = '',
    quality = '1080p',
    effects = [],
    onProgress = () => {},
    tag,
  } = options;

  const height = quality === '720p' ? 1280 : 1920;
  const width = quality === '720p' ? 720 : 1080;
  const duration = Math.max(1, end - start);
  const font = findFont();
  const useZoom = effects.includes('zoom');
  const useGrade = effects.includes('grade');
  const useFade = effects.includes('fade') || effects.includes('transitions');

  const filters = [];
  filters.push('[0:v]split=2[bg][fg]');
  const bgChain = [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, 'boxblur=26:2'];
  bgChain.push(useGrade ? 'eq=brightness=-0.14:saturation=1.25' : 'eq=brightness=-0.14:saturation=0.95');
  filters.push(`[bg]${bgChain.join(',')}[bgv]`);
  filters.push(`[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgv]`);
  let base = '[bgv][fgv]overlay=(W-w)/2:(H-h)/2';
  if (useZoom) {
    base += `,zoompan=z='min(1+on*0.00035,1.10)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=30`;
  }
  filters.push(`${base},format=yuv420p[base]`);

  let chain = '[base]';
  const stages = [];
  if (captions && fs.existsSync(captions)) {
    stages.push(`subtitles='${escapeFilterPath(captions)}'${font ? `:fontsdir='${escapeFilterPath(path.dirname(font))}'` : ''}`);
  }
  if (hook) {
    stages.push(
      `drawtext=text='${escapeDrawText(hook)}':fontcolor=white:fontsize=${Math.round(width * 0.062)}:box=1:boxcolor=black@0.62:boxborderw=${Math.round(width * 0.028)}:x=(w-text_w)/2:y=h*0.12:enable='lt(t,3.2)'${font ? `:fontfile='${escapeFilterPath(font)}'` : ''}`,
    );
  }
  if (watermark) {
    stages.push(
      `drawtext=text='${escapeDrawText(watermark)}':fontcolor=white@0.72:fontsize=${Math.round(width * 0.032)}:x=w-text_w-40:y=h-110${font ? `:fontfile='${escapeFilterPath(font)}'` : ''}`,
    );
  }
  if (useFade) stages.push(`fade=t=in:st=0:d=0.35`, `fade=t=out:st=${Math.max(0, duration - 0.4).toFixed(2)}:d=0.4`);
  if (stages.length) {
    filters.push(`${chain}${stages.join(',')}[vout]`);
    chain = '[vout]';
  } else {
    filters.push(`${chain}copy[vout]`);
    chain = '[vout]';
  }

  const audioFilters = ['loudnorm=I=-14:TP=-1.5:LRA=11'];
  if (useFade) {
    audioFilters.push('afade=t=in:st=0:d=0.25', `afade=t=out:st=${Math.max(0, duration - 0.35).toFixed(2)}:d=0.35`);
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(duration), '-i', source];
  if (!hasAudio) args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=44100:cl=stereo');
  args.push('-filter_complex', filters.join(';'), '-map', chain);
  if (hasAudio) args.push('-map', '0:a:0', '-af', audioFilters.join(','));
  else args.push('-map', '1:a:0', '-shortest');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    quality === '720p' ? '23' : '21',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  );

  let lastProgress = -1;
  await runFF(FFMPEG, args, {
    tag,
    onStdout: (text) => {
      const match = text.match(/out_time_ms=(\d+)/);
      if (!match) return;
      const seconds = Number(match[1]) / 1_000_000;
      const pct = Math.max(0, Math.min(99, Math.round((seconds / duration) * 100)));
      if (pct > lastProgress) {
        lastProgress = pct;
        onProgress(pct);
      }
    },
    timeoutMs: 15 * 60 * 1000,
  });

  if (!fs.existsSync(output) || fs.statSync(output).size < 10_000) {
    throw new Error('Render produced no usable video file.');
  }
  return { path: output, bytes: fs.statSync(output).size, duration, width, height };
}

/** Vertical thumbnail with the generated hook text burned in. */
export async function renderThumbnail({ source, atSeconds, output, text, tag, quality = '1080p' }) {
  const width = quality === '720p' ? 720 : 1080;
  const height = quality === '720p' ? 1280 : 1920;
  const font = findFont();
  const safeText = escapeDrawText(String(text || '').slice(0, 48));
  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'eq=saturation=1.15:contrast=1.05',
  ];
  if (safeText) {
    filters.push(
      `drawtext=text='${safeText}':fontcolor=white:fontsize=${Math.round(width * 0.085)}:box=1:boxcolor=black@0.55:boxborderw=${Math.round(width * 0.03)}:x=(w-text_w)/2:y=h*0.42:line_spacing=12${font ? `:fontfile='${escapeFilterPath(font)}'` : ''}`,
    );
  }
  await runFF(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', source, '-frames:v', '1', '-vf', filters.join(','), '-q:v', '2', output],
    { tag, timeoutMs: 90_000 },
  );
  return output;
}
