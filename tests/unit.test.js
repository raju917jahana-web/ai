import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAss } from '../server/lib/render.js';
import { heuristicMoments } from '../server/lib/pipeline.js';
import { parseYouTubeId } from '../server/lib/agent.js';

/** Strip ASS override tags so assertions can match the spoken words. */
const plain = (line) => line.replace(/\{[^}]*\}/g, '');

test('parseYouTubeId understands the URL shapes users paste', () => {
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://www.youtube.com/shorts/abc123XYZ_-'), 'abc123XYZ_-');
  assert.equal(parseYouTubeId('https://www.youtube.com/embed/abc123XYZ_-'), 'abc123XYZ_-');
  assert.equal(parseYouTubeId('https://vimeo.com/123456'), null);
  assert.equal(parseYouTubeId('not a url'), null);
});

test('buildAss emits one dialogue line per segment with clip-relative timing', () => {
  const ass = buildAss(
    [
      { start: 10, end: 12, text: 'first line' },
      { start: 12.5, end: 14, text: 'second line' },
    ],
    10,
    20,
  );

  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);

  const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 2);
  // Captions are clip-relative because the renderer seeks with -ss: the segment at
  // 10s inside a clip starting at 10s must begin at 0:00:00.00.
  assert.match(dialogues[0], /Dialogue: 0,0:00:00\.00,/);
  assert.match(plain(dialogues[0]), /first line/);
  assert.match(dialogues[1], /0:00:02\.50/);
  assert.match(plain(dialogues[1]), /second line/);
});

test('buildAss skips empty segments instead of rendering blank captions', () => {
  const ass = buildAss(
    [
      { start: 0, end: 1, text: '   ' },
      { start: 1, end: 2, text: 'real words' },
    ],
    0,
    10,
  );
  const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 1);
  assert.match(plain(dialogues[0]), /real words/);
});

test('buildAss clamps captions to the clip window', () => {
  const ass = buildAss(
    [
      { start: 100, end: 110, text: 'before the clip' },
      { start: 45, end: 50, text: 'inside the clip' },
      { start: 80, end: 90, text: 'after the clip' },
    ],
    42,
    60,
  );
  const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 1, 'only the in-window segment is captioned');
  // 45s inside a clip starting at 42s is 3s into the clip, not 45s.
  assert.match(dialogues[0], /Dialogue: 0,0:00:03\.00,0:00:08\.00,/);
  assert.match(plain(dialogues[0]), /inside the clip/);
});

test('heuristicMoments returns in-bounds, non-overlapping highlights', () => {
  const duration = 90;
  const energy = Array.from({ length: duration }, (_, i) => ({ t: i, rms: 0.1 + 0.6 * Math.abs(Math.sin(i / 4)) }));
  const scenes = [{ t: 0 }, { t: 15 }, { t: 31 }, { t: 47 }, { t: 62 }, { t: 78 }];

  const moments = heuristicMoments({
    duration,
    transcript: null,
    energy,
    scenes,
    silence: [],
    count: 3,
    minDuration: 15,
    maxDuration: 45,
  });

  assert.ok(moments.length > 0, 'expected at least one moment');
  assert.ok(moments.length <= 3, 'never more than the requested count');

  const sorted = [...moments].sort((a, b) => a.start - b.start);
  for (const moment of sorted) {
    assert.ok(moment.start >= 0, 'start is never negative');
    assert.ok(moment.end <= duration + 0.001, 'end never exceeds the source duration');
    assert.ok(moment.end > moment.start, 'end is after start');
    assert.ok(moment.end - moment.start >= 14.5, 'respects the minimum clip duration');
    assert.ok(moment.end - moment.start <= 45.001, 'respects the maximum clip duration');
  }

  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].start >= sorted[i - 1].end - 0.001, 'highlights do not overlap');
  }
});

test('heuristicMoments never invents moments for a video shorter than a clip', () => {
  const moments = heuristicMoments({
    duration: 3,
    transcript: null,
    energy: [{ t: 0, rms: 0.2 }, { t: 1, rms: 0.3 }],
    scenes: [],
    silence: [],
    count: 5,
    minDuration: 15,
    maxDuration: 45,
  });
  for (const moment of moments) {
    assert.ok(moment.end <= 3.001, 'clamped to the real duration');
    assert.ok(moment.start >= 0);
  }
});
