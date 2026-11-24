import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= {}; // config.js 가 window 를 본다 (노드에는 없음)
const { micSummary, micIcon } = await import('../public/js/mic.js');

const buds = { key: 'bluetooth:Galaxy Buds2 Pro', name: 'Galaxy Buds2 Pro (블루투스)', kind: 'bluetooth' };
const phone = { key: 'phone:', name: '휴대폰 마이크', kind: 'phone' };

test('기본 마이크', () => {
  assert.deepEqual(micSummary({ devices: [phone], selected: 'auto', active: 'auto' }), { text: '휴대폰 기본 마이크', warn: false });
});

test('고른 이어폰이 연결돼 있으면 그 이름', () => {
  assert.deepEqual(micSummary({ devices: [phone, buds], selected: buds.key, active: buds.key }), { text: buds.name, warn: false });
});

test('고른 이어폰이 끊기면 경고 + 휴대폰 마이크로 듣는다고 안내', () => {
  const r = micSummary({ devices: [phone], selected: buds.key, active: 'auto' });
  assert.equal(r.warn, true);
  assert.match(r.text, /끊겼어요/);
});

test('장치 종류별 아이콘', () => {
  assert.equal(micIcon('phone'), '📱');
  assert.equal(micIcon('bluetooth'), '🎧');
});
