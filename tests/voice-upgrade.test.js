import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, planWithAI } from '../public/js/intent.js';
import { runWorkoutDialog } from '../public/js/dialogs.js';
import { transcribeWithAI, STT_MODEL } from '../public/js/ai.js';
import * as store from '../public/js/store.js';
import { isNegatedControl, parseRest } from '../public/js/commands.js';

const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k) || null, setItem: (k,v) => memory.set(k,v), removeItem: (k) => memory.delete(k) };
const listeners = new Map();
const emit = (name, value = {}) => { for (const cb of listeners.get(name) || []) cb(value); };
let recordingImpl;
let cancelled = 0;
const plugin = {
  ensurePermission: async () => ({ granted: true }),
  addListener: async (name, cb) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return { remove: async () => listeners.get(name).delete(cb) };
  },
  recordUtterance: (args) => recordingImpl(args),
  cancelRecording: async () => { cancelled++; },
  cancel: async () => emit('speechEnd'),
  stop: async () => {},
  start: async () => {
    queueMicrotask(() => {
      emit('speechPartial', { text: '스쿼트 열 개' });
      emit('speechFinal', { text: '스쿼트 열두 개', alternatives: ['스쿼트 열두 개'] });
      emit('speechEnd');
    });
    return { capture: false };
  },
};
globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { VoiceListener: plugin } } };
const { createVoiceEngine } = await import('../public/js/speech.js');
const entry = (reps = 12) => ({ sport: '맨몸운동', activity: '스쿼트', category: '맨몸', metrics: { reps, sets: 1 }, note: '' });
const action = (kind, extra = {}) => ({ kind, entries: [], seconds: null, reply: '', query: '', ...extra });
const plan = (...actions) => ({ confidence: 0.95, actions });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('APK: auto/OpenAI actually select cloud transcription; explicit device mode remains local', () => {
  assert.equal(createVoiceEngine('auto', true).kind, 'native-openai');
  assert.equal(createVoiceEngine('openai', true).kind, 'native-openai');
  assert.equal(createVoiceEngine('auto', false).kind, 'native');
  assert.equal(createVoiceEngine('browser', true).kind, 'native');
});

test('native PCM -> OpenAI: ready/speech/processing events, context, final text and cleanup', async () => {
  memory.set('vf.openaiKey.v1', 'test-only-key');
  const events = [];
  recordingImpl = async ({ id, silenceMs }) => {
    assert.equal(silenceMs, 1800);
    emit('recordReady', { id });
    emit('recordLevel', { id, speech: true, level: 4 });
    return { wav: btoa('RIFF-test') };
  };
  globalThis.fetch = async (url, opts) => {
    assert.ok(url.endsWith('/audio/transcriptions'));
    assert.equal(opts.body.get('model'), STT_MODEL);
    assert.match(opts.body.get('prompt'), /벤치프레스/);
    assert.equal(await opts.body.get('file').text(), 'RIFF-test');
    return response({ text: '열 개, 아니 열두 개 했어' });
  };
  const engine = createVoiceEngine('auto', true);
  const text = await engine.listenOnce({ context: '벤치프레스', onReady: () => events.push('ready'), onSpeech: () => events.push('speech'), onProcessing: () => events.push('processing') });
  assert.equal(text, '열 개, 아니 열두 개 했어');
  assert.deepEqual(events, ['ready', 'speech', 'processing']);
  assert.deepEqual(engine.candidates, [text]);
  for (const set of listeners.values()) assert.equal(set.size, 0);
});

test('cancelling an in-flight transcription discards late text and aborts the request', async () => {
  const engine = createVoiceEngine('auto', true);
  let finish;
  let signal;
  let reached;
  const ready = new Promise((r) => { reached = r; });
  globalThis.fetch = async (_url, opts) => { signal = opts.signal; reached(); return new Promise((r) => { finish = r; }); };
  const pending = engine.listenOnce();
  await ready;
  engine.cancel();
  assert.equal(signal.aborted, true);
  finish(response({ text: '스쿼트 100개' }));
  assert.equal(await pending, null);
  assert.deepEqual(engine.candidates, []);
  assert.ok(cancelled > 0);
});

test('wake/count use no paid transcription and exclude stale partial candidates', async () => {
  globalThis.fetch = async () => { throw new Error('must not send wake/count audio'); };
  const engine = createVoiceEngine('auto', true);
  for (const mode of ['wake', 'count', 'signal', 'calibrate']) {
    assert.equal(await engine.listenOnce({ mode }), '스쿼트 열두 개');
    assert.deepEqual(engine.candidates, ['스쿼트 열두 개']);
  }
});

test('quota failure is surfaced, not disguised as an empty transcript or local success', async () => {
  globalThis.fetch = async () => response({ error: { code: 'insufficient_quota' } }, 429);
  await assert.rejects(transcribeWithAI(new Blob(['wav'])), (e) => e.code === 'quota');
});

test('unavailable transcription model falls back once; authentication does not retry', async () => {
  const models = [];
  globalThis.fetch = async (_url, opts) => {
    models.push(opts.body.get('model'));
    return models.length === 1 ? response({ error: { code: 'model_not_found' } }, 404) : response({ text: '휴식 90초' });
  };
  assert.equal(await transcribeWithAI(new Blob(['wav'])), '휴식 90초');
  assert.deepEqual(models, [STT_MODEL, 'gpt-4o-transcribe']);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({}, 401); };
  await assert.rejects(transcribeWithAI(new Blob(['wav'])), (e) => e.code === 'invalid-key');
  assert.equal(calls, 1);
});

test('semantic plans preserve compound order and reject unknown/invalid operations before execution', () => {
  assert.deepEqual(validatePlan(plan(action('log', { entries: [entry()] }), action('rest', { seconds: 90 }))).actions.map((a) => a.kind), ['log', 'rest']);
  for (const raw of [
    { actions: [action('undo')] }, { confidence: 0.4, actions: [action('undo')] },
    plan(action('send_sms')), plan(action('log', { entries: [entry(-5)] })),
    plan(action('rest', { seconds: 900 })), plan(action('correct')), plan(action('timer', { entries: [entry()] })),
    plan(action('log', { entries: [entry(12.5)] })),
  ]) assert.equal(validatePlan(raw).actions[0].kind, 'clarify');
});

test('negative local controls cannot stop timers or end rest', () => {
  for (const text of ['휴식 끝내지 마', '카운트 멈추지 말고 계속해', '아직 시작하지 마']) assert.equal(isNegatedControl(text), true);
  assert.equal(parseRest('휴식 끝내지 마'), null);
  assert.equal(isNegatedControl('휴식 끝'), false);
});

test('ambiguous follow-up numbers are not silently saved; cancellation discards the pending record', async () => {
  let saved = false;
  for (const intent of ['unknown', 'undo']) {
    const io = { say: async () => {}, listen: async () => '아니 취소', last: () => null,
      parse: async () => ({ source: 'ai', result: { intent, entries: [], confidence: 0.5 } }),
      save: () => { saved = true; return []; } };
    const result = { intent: 'log', confidence: 0.95, entries: [{ ...entry(), metrics: {} }] };
    const r = await runWorkoutDialog(io, '스쿼트', { session: true, requestedMode: 'log', parsed: { result, source: 'ai' } });
    assert.equal(r.status, intent === 'undo' ? 'cancelled' : 'failed');
    assert.equal(saved, false);
  }
});

test('semantic classification overrides keyword traps in the workout dialog', async () => {
  let saved = null;
  const io = { say: async () => {}, listen: async () => null, last: () => null,
    parse: async () => { throw new Error('plan should not be parsed twice'); },
    save: (entries) => { saved = entries; return entries; } };
  const result = { intent: 'log', confidence: 0.95, entries: [entry()] };
  const r = await runWorkoutDialog(io, '카운트하지 말고 스쿼트 열두 개 기록해', { session: true, requestedMode: 'log', parsed: { result, source: 'ai' } });
  assert.equal(r.status, 'saved');
  assert.equal(saved[0].metrics.reps, 12);
  saved = null;
  const count = await runWorkoutDialog(io, '그거 열두 번만 같이 해줄래', { session: true, requestedMode: 'count', parsed: { result, source: 'ai' } });
  assert.equal(count.status, 'counting');
  assert.equal(saved, null);
});

test('last-record correction retains identity/date; stale target cannot modify another record', () => {
  store.clearEntries();
  const original = store.addEntries([entry(10)], '10개', 'ai')[0];
  const updated = store.correctLastEntry(original.id, entry(12), '아니 12개');
  assert.equal(updated.id, original.id);
  assert.equal(updated.date, original.date);
  assert.equal(store.getEntries().length, 1);
  assert.equal(store.lastEntry().metrics.reps, 12);
  store.addEntries([entry(20)], '20개', 'ai');
  assert.equal(store.correctLastEntry(original.id, entry(99), '99개'), null);
  assert.equal(store.lastEntry().metrics.reps, 20);
});

test('intent API includes bounded context and strict schema; no key or raw device storage in messages', async () => {
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.response_format.json_schema.strict, true);
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.turns.length, 8);
    assert.equal(context.last.metrics.reps, 10);
    assert.equal(context.text, '아니 열두 개로 고쳐');
    assert.ok(!body.messages[1].content.includes('test-only-key'));
    return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan(action('correct', { entries: [entry(12)] }))) } }] });
  };
  const r = await planWithAI('아니 열두 개로 고쳐', { last: entry(10), turns: Array.from({ length: 20 }, () => ({ role: 'user', text: '안녕' })) });
  assert.equal(r.actions[0].kind, 'correct');
});

test('AI 목소리는 기본 꺼짐이고, 예전에 자동으로 켜진 값도 한 번 꺼진다', async () => {
  const mem = {};
  globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const store = await import('../public/js/store.js?nv=' + Date.now());
  assert.equal(store.DEFAULT_SETTINGS.naturalVoice, false);
  mem['vf.settings.v1'] = JSON.stringify({ naturalVoice: true, settingsVersion: 3 });
  assert.equal(store.getSettings().naturalVoice, false);
  store.saveSettings({ naturalVoice: true });
  assert.equal(store.getSettings().naturalVoice, true, '사용자가 켠 값은 유지');
});
