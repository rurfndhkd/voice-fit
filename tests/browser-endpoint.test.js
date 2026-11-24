import test from 'node:test';
import assert from 'node:assert/strict';

let recognition, amplitude = 0, tracksStopped = 0, closed = 0, fetchCount = 0;
let recorder;
class Recognition {
  constructor() { recognition = this; this.stops = 0; }
  start() { this.onaudiostart?.(); }
  stop() { this.stops++; this.onend?.(); }
  abort() { this.onend?.(); }
}
class Recorder {
  static isTypeSupported() { return true; }
  constructor() { recorder = this; this.state = 'inactive'; this.mimeType = 'audio/webm'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio']) });
    this.onstop?.();
  }
}
class AudioContext {
  async resume() {}
  async close() { closed++; }
  createAnalyser() { return { fftSize: 512, getFloatTimeDomainData: (buf) => buf.fill(amplitude) }; }
  createMediaStreamSource() { return { connect() {} }; }
}
const stream = { getTracks: () => [{ stop: () => { tracksStopped++; } }] };
globalThis.window = { SpeechRecognition: Recognition, MediaRecorder: Recorder, AudioContext };
globalThis.MediaRecorder = Recorder;
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } });
globalThis.localStorage = { getItem: (key) => key === 'vf.openaiKey.v1' ? 'test-only-key' : null };
const { createVoiceEngine } = await import('../public/js/speech.js');
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function clock(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return (ms) => { for (let i = 0; i < ms; i += 20) { now += Math.min(20, ms - i); t.mock.timers.tick(Math.min(20, ms - i)); } };
}
function result(text) {
  const r = [{ transcript: text }]; r.isFinal = false;
  recognition.onresult({ resultIndex: 0, results: [r] });
}

test('web device: 1.5 seconds after speech-end processes the accumulated text once', async (t) => {
  const tick = clock(t);
  let processing = 0;
  const engine = createVoiceEngine('browser');
  const pending = engine.listenOnce({ onProcessing: () => processing++ });
  recognition.onspeechstart(); result('스쿼트 열두 개'); recognition.onspeechend();
  tick(1480); assert.equal(recognition.stops, 0);
  result('스쿼트 열두 개 했어'); // Delayed transcript must not extend microphone silence.
  tick(20);
  assert.equal(await pending, '스쿼트 열두 개 했어');
  assert.equal(recognition.stops, 1); assert.equal(processing, 1);
});
test('web device: resuming speech cancels the earlier deadline; cancellation discards text', async (t) => {
  const tick = clock(t);
  const engine = createVoiceEngine('browser');
  const pending = engine.listenOnce();
  recognition.onspeechstart(); result('열 개'); recognition.onspeechend();
  tick(1000); recognition.onspeechstart(); tick(1000);
  assert.equal(recognition.stops, 0);
  engine.cancel(); tick(2000);
  assert.equal(await pending, null); assert.deepEqual(engine.candidates, []);
  assert.equal(recognition.stops, 0);
});
test('web OpenAI: capture ends at 1500ms, releases mic and submits once with context', async (t) => {
  const tick = clock(t);
  amplitude = 0.02; tracksStopped = 0; closed = 0; fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    fetchCount++; assert.ok(tracksStopped > 0);
    assert.match(opts.body.get('prompt'), /벤치프레스/);
    return new Response(JSON.stringify({ text: '벤치프레스 열두 개' }));
  });
  const events = [];
  const engine = createVoiceEngine('openai', true);
  const pending = engine.listenOnce({ context: '벤치프레스', onReady: () => events.push('ready'), onProcessing: () => events.push('processing') });
  await flush(); tick(200); amplitude = 0; tick(1480); await flush();
  assert.equal(recorder.state, 'recording'); assert.equal(fetchCount, 0);
  tick(20); await flush();
  assert.equal(await pending, '벤치프레스 열두 개');
  assert.equal(fetchCount, 1); assert.equal(closed, 1);
  assert.deepEqual(events, ['ready', 'processing']);
});
test('web OpenAI: silence alone never sends an audio request', async (t) => {
  const tick = clock(t); amplitude = 0;
  t.mock.method(globalThis, 'fetch', () => { assert.fail('silence uploaded'); });
  const engine = createVoiceEngine('openai', true);
  const pending = engine.listenOnce({ timeoutMs: 2000 });
  await flush(); tick(2000); await flush();
  assert.equal(await pending, null); assert.equal(recorder.state, 'inactive');
});
test('web OpenAI: cancellation during upload aborts and discards a late response', async (t) => {
  const tick = clock(t); amplitude = 0.02;
  let finish, signal;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => { signal = opts.signal; return new Promise((r) => { finish = r; }); });
  const engine = createVoiceEngine('openai', true);
  const pending = engine.listenOnce();
  await flush(); tick(200); amplitude = 0; tick(1500); await flush();
  assert.ok(finish); engine.cancel(); assert.equal(signal.aborted, true);
  finish(new Response(JSON.stringify({ text: '운동 종료' })));
  assert.equal(await pending, null); assert.deepEqual(engine.candidates, []);
});
