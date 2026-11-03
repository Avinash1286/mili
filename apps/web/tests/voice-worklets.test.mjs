import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../public/voice-worklets.js', import.meta.url), 'utf8');
function processor(name, rate) {
  const classes = new Map();
  class Processor {
    constructor() { this.messages = []; this.port = { postMessage: value => this.messages.push(value), onmessage: null }; }
  }
  const context = createContext({ sampleRate: rate, AudioWorkletProcessor: Processor, registerProcessor: (key, value) => classes.set(key, value), Int16Array, Float32Array });
  runInContext(source, context);
  return new (classes.get(name))();
}
function captureFrames(capture, length, value = .25, channels = 1) {
  for (let start = 0; start < length; start += 128) {
    const count = Math.min(128, length - start);
    const input = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: count }, (_, i) => typeof value === 'function' ? value(start + i, c) : value));
    const output = new Float32Array(count).fill(1);
    assert.equal(capture.process([input], [[output]]), true);
    assert.ok(output.every(sample => sample === 0), 'microphone must never monitor into speakers');
  }
}
function command(playback, data) { playback.port.onmessage({ data }); }
function render(playback, frames = 128, channels = 1) {
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  assert.equal(playback.process([], [output]), true);
  return output;
}

for (const rate of [16000, 44100, 48000, 96000]) {
  test(`capture ${rate} Hz produces exactly 16 kHz PCM in 50 ms packets`, () => {
    const capture = processor('tokai-capture', rate);
    captureFrames(capture, rate);
    assert.equal(capture.messages.length, 20);
    for (const frame of capture.messages) {
      assert.equal(frame.samples.length, 800);
      assert.ok(frame.samples.every(sample => sample === 8192));
      assert.equal(frame.rms, .25);
    }
  });
}
test('capture averages channels, clips peaks, and resets buffered audio between utterances', () => {
  const capture = processor('tokai-capture', 48000);
  captureFrames(capture, 2400, (_, channel) => channel === 0 ? 1 : -1, 2);
  assert.ok(capture.messages[0].samples.every(sample => sample === 0));
  captureFrames(capture, 600, 1);
  command(capture, { type: 'reset' });
  captureFrames(capture, 2400, -2);
  assert.ok(capture.messages[1].samples.every(sample => sample === -32768));
  captureFrames(capture, 600, 2);
  command(capture, { type: 'flush' });
  assert.equal(capture.messages[2].final, true);
  assert.equal(capture.messages[2].samples.length, 200);
  assert.ok(capture.messages[2].samples.every(sample => sample === 32767));
  command(capture, { type: 'flush' });
  assert.equal(capture.messages[3].samples.length, 0);
  assert.equal(capture.messages[3].final, true, 'release must be acknowledged even with no partial packet');
});
test('44.1 kHz capture preserves the time and shape of a 1 kHz signal across render quanta', () => {
  const capture = processor('tokai-capture', 44100);
  captureFrames(capture, 44100, i => .5 * Math.sin(2 * Math.PI * 1000 * i / 44100));
  const samples = capture.messages.flatMap(frame => [...frame.samples]);
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / samples.length);
  assert.ok(rms > .34 && rms < .36);
  const crossings = samples.reduce((sum, sample, i) => sum + (i > 0 && samples[i - 1] <= 0 && sample > 0 ? 1 : 0), 0);
  assert.ok(crossings >= 999 && crossings <= 1001);
});
for (const rate of [24000, 44100, 48000]) {
  test(`playback at ${rate} Hz preserves duration and acknowledges native 24 kHz samples`, () => {
    const playback = processor('tokai-playback', rate);
    command(playback, { type: 'clear', epoch: 1 });
    command(playback, { type: 'start', epoch: 1, streamId: 7 });
    command(playback, { type: 'chunk', epoch: 1, streamId: 7, samples: new Int16Array(2400).fill(16384) });
    command(playback, { type: 'end', epoch: 1, streamId: 7 });
    const samples = [];
    for (let i = 0; i < Math.ceil(rate * .1 / 128) + 2; i++) {
      const [left, right] = render(playback, 128, 2);
      assert.deepEqual(left, right);
      samples.push(...left);
    }
    const nonzero = samples.filter(sample => sample !== 0);
    assert.ok(Math.abs(nonzero.length - rate * .1) <= 1, `output duration: ${nonzero.length} samples`);
    assert.ok(nonzero.every(sample => sample === .5));
    const completed = playback.messages.find(event => event.status === 'completed');
    assert.equal(completed.playedSamples, 2400);
    assert.equal(completed.outputEpoch, 1);
    assert.equal(completed.streamId, 7);
    assert.equal(playback.streams.length, 0);
    assert.equal(playback.queued, 0);
  });
}
test('temporary underruns do not advance the source clock or count silence as heard', () => {
  const playback = processor('tokai-playback', 48000);
  command(playback, { type: 'start', epoch: 0, streamId: 1 });
  command(playback, { type: 'chunk', epoch: 0, streamId: 1, samples: new Int16Array([1000, 2000]) });
  render(playback);
  const position = playback.streams[0].position;
  for (let i = 0; i < 100; i++) assert.ok(render(playback)[0].every(sample => sample === 0));
  assert.equal(playback.streams[0].position, position);
  assert.equal(playback.messages.filter(event => event.status === 'underrun').length, 1);
  command(playback, { type: 'chunk', epoch: 0, streamId: 1, samples: new Int16Array([3000, 4000]) });
  command(playback, { type: 'end', epoch: 0, streamId: 1 });
  const output = render(playback)[0];
  assert.equal(output[0], 2000 / 32768);
  assert.equal(playback.messages.find(event => event.status === 'completed').playedSamples, 4);
});
test('interrupt clears audio immediately and stale epochs never replay', () => {
  const playback = processor('tokai-playback', 48000);
  command(playback, { type: 'start', epoch: 0, streamId: 1 });
  command(playback, { type: 'chunk', epoch: 0, streamId: 1, samples: new Int16Array(5000).fill(16000) });
  render(playback, 256);
  command(playback, { type: 'clear', epoch: 1 });
  assert.equal(playback.messages.find(event => event.status === 'interrupted').playedSamples, 128);
  command(playback, { type: 'chunk', epoch: 0, streamId: 1, samples: new Int16Array(1000).fill(16000) });
  command(playback, { type: 'start', epoch: 0, streamId: 2 });
  assert.ok(render(playback)[0].every(sample => sample === 0));
  assert.equal(playback.streams.length, 0);
  command(playback, { type: 'start', epoch: 1, streamId: 2 });
  command(playback, { type: 'chunk', epoch: 1, streamId: 2, samples: new Int16Array(100).fill(-16000) });
  command(playback, { type: 'end', epoch: 1, streamId: 2 });
  assert.equal(render(playback)[0][0], -16000 / 32768);
});
test('playback queues are bounded at eight seconds and provide paced progress acknowledgments', () => {
  const playback = processor('tokai-playback', 48000);
  command(playback, { type: 'start', epoch: 0, streamId: 1 });
  for (let i = 0; i < 12; i++) command(playback, { type: 'chunk', epoch: 0, streamId: 1, samples: new Int16Array(16000).fill(1234) });
  command(playback, { type: 'chunk', epoch: 0, streamId: 1, samples: new Int16Array(800) });
  assert.equal(playback.queued, 192000);
  assert.equal(playback.messages.filter(event => event.type === 'overflow').length, 1);
  for (let i = 0; i < 75; i++) render(playback);
  const progress = playback.messages.filter(event => event.status === 'progress');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].playedSamples, 4800);
});
