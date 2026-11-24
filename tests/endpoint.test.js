import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechEndpoint, ActivityGate } from '../public/js/endpoint.js';

function spoken() {
  const ep = new SpeechEndpoint(0);
  for (let t = 0; t <= 200; t += 20) assert.equal(ep.feed(true, t), false);
  return ep;
}
test('PLAN 23: 1499ms silence keeps listening, 1500ms ends the utterance', () => {
  const ep = spoken();
  assert.equal(ep.feed(false, 1699), false);
  assert.equal(ep.feed(false, 1700), true);
});
test('PLAN 23: resumed speech resets the deadline, even just before it expires', () => {
  const ep = spoken();
  ep.feed(false, 1600);
  for (let t = 1680; t <= 1780; t += 20) assert.equal(ep.feed(true, t), false);
  assert.equal(ep.feed(false, 3279), false);
  assert.equal(ep.feed(false, 3280), true);
});
test('PLAN 23: isolated noise during the silence does not restart 1500ms', () => {
  const ep = spoken();
  ep.feed(false, 500);
  ep.feed(true, 1000);
  ep.feed(false, 1020);
  assert.equal(ep.feed(false, 1700), true);
});
test('PLAN 23: silence and clicks before speech do not produce a recording', () => {
  const ep = new SpeechEndpoint(0, { waitMs: 5000 });
  ep.feed(true, 100);
  ep.feed(false, 120);
  assert.equal(ep.feed(false, 1500), false);
  assert.equal(ep.feed(false, 4999), false);
  assert.equal(ep.feed(false, 5000), true);
  assert.equal(ep.heard, false);
});
test('PLAN 23: continuous speech is bounded at 30 seconds', () => {
  const ep = spoken();
  assert.equal(ep.feed(true, 29999), false);
  assert.equal(ep.feed(true, 30000), true);
});
test('PLAN 23: low ambient energy does not keep the turn alive', () => {
  const gate = new ActivityGate();
  const ep = spoken();
  for (let t = 220; t < 1700; t += 20) {
    assert.equal(ep.feed(gate.feed(new Float32Array(320).fill(0.001)), t), false);
  }
  assert.equal(ep.feed(gate.feed(new Float32Array(320).fill(0.001)), 1700), true);
  assert.equal(gate.feed(new Float32Array(320).fill(0.02)), true);
});
