import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocal } from '../public/js/parser-local.js';
import { sanitizeParse } from '../public/js/schema.js';

const one = (text, last) => parseLocal(text, last).entries[0];

test('맨몸: 횟수와 세트', () => {
  const e = one('스쿼트 15개 3세트');
  assert.equal(e.activity, '스쿼트');
  assert.equal(e.category, '맨몸');
  assert.equal(e.metrics.reps, 15);
  assert.equal(e.metrics.sets, 3);
});

test('웨이트: 킬로는 무게', () => {
  const e = one('벤치프레스 60킬로 8개 4세트');
  assert.equal(e.category, '웨이트');
  assert.equal(e.metrics.weight_kg, 60);
  assert.equal(e.metrics.reps, 8);
});

test('유산소: 킬로는 거리, 분은 초로', () => {
  const e = one('러닝 5킬로 30분 뛰었어');
  assert.equal(e.category, '유산소');
  assert.equal(e.metrics.distance_m, 5000);
  assert.equal(e.metrics.duration_sec, 1800);
  assert.equal(e.metrics.weight_kg, null);
});

test('격투기: 한글 수사 라운드', () => {
  const e = one('스파링 3분 다섯 라운드');
  assert.equal(e.category, '격투기');
  assert.equal(e.metrics.rounds, 5);
  assert.equal(e.metrics.duration_sec, 180);
});

test('구기: 종목 인식', () => {
  const e = one('축구 슈팅 연습 20개');
  assert.equal(e.sport, '축구');
  assert.equal(e.category, '구기');
});

test('여러 운동 한 번에', () => {
  const r = parseLocal('푸시업 20개, 플랭크 1분');
  assert.equal(r.entries.length, 2);
});

test('한 세트 더 → 직전 기록 복사', () => {
  const last = one('스쿼트 15개 3세트');
  const e = one('한 세트 더', last);
  assert.equal(e.activity, '스쿼트');
  assert.equal(e.metrics.sets, 1);
  assert.equal(e.metrics.reps, 15);
});

test('취소 / 무관한 말', () => {
  assert.equal(parseLocal('방금 거 취소').intent, 'undo');
  assert.equal(parseLocal('오늘 날씨 어때').intent, 'unknown');
});

test('AI 응답 정리: 이상한 값 제거', () => {
  const r = sanitizeParse({ intent: 'log', entries: [{ activity: 'x', category: '없는분류', metrics: { reps: '-3', sets: '2' } }] });
  assert.equal(r.entries[0].category, '기타');
  assert.equal(r.entries[0].metrics.reps, null);
  assert.equal(r.entries[0].metrics.sets, 2);
  assert.equal(sanitizeParse({ intent: 'hack' }).intent, 'unknown');
});
