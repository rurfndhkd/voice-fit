// PLAN 6·9·12·13·15 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRest, parseSeconds, rangeProblem, restLabel, withRo } from '../public/js/commands.js';
import { END_SESSION_RE } from '../public/js/dialogs.js';
import { summarize, duration } from '../public/js/summary.js';
import { answerQuestion, isQuestion, parseRange, findActivity, topic } from '../public/js/answer.js';
import { runWorkoutDialog } from '../public/js/dialogs.js';
import { parseLocal, localConfidence } from '../public/js/parser-local.js';
import { sanitizeParse } from '../public/js/schema.js';

function fakeIO(answers, parse) {
  const said = [];
  const saved = [];
  return {
    said, saved,
    say: async (t) => { said.push(t); },
    listen: async () => answers.shift() ?? null,
    parse: parse || (async (text, last) => ({ result: parseLocal(text, last), source: 'local' })),
    save: (entries) => { saved.push(...entries); return entries; },
    undo: () => null,
    last: () => null,
  };
}

/* ---------- PLAN 6: 확신도 ---------- */
test('PLAN 6: 확신도는 0~1로 정리, 없으면 1, 퍼센트도 받음', () => {
  assert.equal(sanitizeParse({ intent: 'unknown' }).confidence, 1);
  assert.equal(sanitizeParse({ intent: 'unknown', confidence: 0.4 }).confidence, 0.4);
  assert.equal(sanitizeParse({ intent: 'unknown', confidence: 65 }).confidence, 0.65);
});

test('PLAN 6: 오프라인 해석 확신도 — 아는 운동은 높고, 이름 없는 숫자는 낮다', () => {
  assert.ok(parseLocal('스쿼트 20개').confidence >= 0.7);
  assert.ok(parseLocal('요가 30분').confidence >= 0.7);
  assert.equal(parseLocal('요가 30분').entries[0].activity, '요가'); // '가'를 조사로 떼던 버그
  assert.equal(parseLocal('스쿼트를 20개').entries[0].activity, '스쿼트');
  assert.ok(localConfidence([{ category: '기타', activity: '운동' }]) < 0.7);
});

test('PLAN 6: AI 확신도 70% 미만이면 기록하지 않고 "다시 말씀해 주세요"', async () => {
  const lowAI = async () => ({ result: sanitizeParse({ intent: 'log', confidence: 0.55, entries: [{ activity: '스쿼트', category: '맨몸', metrics: { reps: 20 } }] }), source: 'ai' });
  const io = fakeIO([], lowAI);
  const r = await runWorkoutDialog(io, '스쿼드 이십 개', { session: true });
  assert.equal(r.status, 'failed');
  assert.equal(io.saved.length, 0);
  assert.match(io.said.at(-1), /다시 말씀해 주세요/);
});

test('PLAN 6: 확신도 70% 이상이면 그대로 기록', async () => {
  const okAI = async () => ({ result: sanitizeParse({ intent: 'log', confidence: 0.92, entries: [{ activity: '스쿼트', category: '맨몸', metrics: { reps: 20 } }] }), source: 'ai' });
  const io = fakeIO([], okAI);
  const r = await runWorkoutDialog(io, '스쿼트 20개', { session: true });
  assert.equal(r.status, 'saved');
  assert.equal(io.saved.length, 1);
});

/* ---------- PLAN 9: 범위 ---------- */
test('PLAN 9: 횟수·세트 1~1000 범위 확인', () => {
  assert.equal(rangeProblem([{ activity: '스쿼트', metrics: { reps: 20, sets: 3 } }]), null);
  assert.equal(rangeProblem([{ activity: '스쿼트', metrics: { reps: 1000 } }]), null);
  assert.match(rangeProblem([{ activity: '스쿼트', metrics: { reps: 1001 } }]), /1에서 1000/);
  assert.match(rangeProblem([{ activity: '스쿼트', metrics: { sets: 5000 } }]), /세트는/);
  assert.match(rangeProblem([{ activity: '스쿼트', metrics: { reps: 2.5 } }]), /횟수는/);
});

test('PLAN 9: 범위 밖이면 기록하지 않고 소리로 알림 (카운트 목표도)', async () => {
  const io = fakeIO([]);
  const r = await runWorkoutDialog(io, '스쿼트 2000개', { session: true });
  assert.equal(r.status, 'invalid');
  assert.equal(io.saved.length, 0);
  assert.match(io.said.at(-1), /1에서 1000/);
  const io2 = fakeIO([]);
  const r2 = await runWorkoutDialog(io2, '푸시업 5000개 카운트 시작', { session: true });
  assert.equal(r2.status, 'invalid');
});

test('PLAN 9: "얼마나 했어요?"에 범위 밖 숫자로 대답해도 기록하지 않음', async () => {
  const io = fakeIO(['3000개']);
  const r = await runWorkoutDialog(io, '스쿼트', { session: true });
  assert.equal(r.status, 'invalid');
  assert.equal(io.saved.length, 0);
});

/* ---------- PLAN 12: 휴식 ---------- */
test('PLAN 12: 휴식 시간 읽기', () => {
  assert.equal(parseSeconds('휴식 60초'), 60);
  assert.equal(parseSeconds('1분 30초 쉴게'), 90);
  assert.equal(parseSeconds('2분 쉬자'), 120);
  assert.equal(parseSeconds('1분 반 휴식'), 90);
  assert.equal(parseSeconds('구십 초 휴식'), 90);
  assert.equal(parseSeconds('삼십초 쉬자'), 30);
});

test('PLAN 12: 휴식 명령 — 시작·끝·범위 밖·시간 없음', () => {
  assert.deepEqual(parseRest('휴식 60초'), { action: 'start', seconds: 60, problem: null });
  assert.deepEqual(parseRest('1분 쉴게'), { action: 'start', seconds: 60, problem: null });
  assert.deepEqual(parseRest('휴식 끝'), { action: 'end' });
  assert.deepEqual(parseRest('그만 쉴래'), { action: 'end' });
  assert.match(parseRest('휴식 5초').problem, /10초에서 300초/);
  assert.match(parseRest('10분 휴식').problem, /10초에서 300초/);
  assert.deepEqual(parseRest('휴식'), { action: 'start', seconds: null, problem: null });
  assert.equal(parseRest('스쿼트 20개'), null);
  assert.equal(parseRest('다음 세트'), null); // "다음 세트"는 휴식을 자동으로 시작하지 않는다
  assert.equal(restLabel(90), '1분 30초');
});

/* ---------- PLAN 13: 요약 ---------- */
test('PLAN 13: 결과 요약은 기록된 숫자만', () => {
  const entries = [
    { activity: '스쿼트', metrics: { reps: 12, sets: 1 } },
    { activity: '스쿼트', metrics: { reps: 10, sets: 1 } },
    { activity: '푸시업', metrics: { reps: 15, sets: 3 } },
    { activity: '플랭크', metrics: { duration_sec: 60, sets: 2 } },
  ];
  const s = summarize(entries, { startedAt: 0, endedAt: 25 * 60 * 1000, restSec: 240 });
  assert.equal(s.items.length, 3);
  assert.equal(s.items[0].text, '2세트 · 총 22개');
  assert.equal(s.items[0].detail, '12 · 10');
  assert.equal(s.items[1].text, '3세트 · 총 45개');
  assert.equal(s.items[2].text, '2세트 · 2분');
  assert.equal(s.totalSec, 1500);
  assert.match(s.spoken, /운동 시간 25분, 휴식 4분/);
  assert.equal(duration(3700), '1시간 1분');
});

/* ---------- PLAN 15: 기록 질문 ---------- */
const NOW = new Date(2026, 10, 23, 20, 0); // 11월 23일 월요일
const at = (d, h = 10) => new Date(2026, 10, d, h).toISOString();
const DATA = [
  { activity: '스쿼트', date: at(23), metrics: { reps: 12, sets: 3 } },
  { activity: '푸시업', date: at(23), metrics: { reps: 15, sets: 2 } },
  { activity: '스쿼트', date: at(22), metrics: { reps: 10, sets: 1 } },
  { activity: '런지', date: at(20), metrics: { reps: 20, sets: 2 } },
  { activity: '러닝', date: at(23, 7), metrics: { duration_sec: 1800, distance_m: 5000 } },
];

test('PLAN 15: 질문인지 구분 (기록 문장은 질문이 아님)', () => {
  assert.equal(isQuestion('오늘 스쿼트 몇 개 했어'), true);
  assert.equal(isQuestion('어제 뭐 했어'), true);
  assert.equal(isQuestion('이번 주 기록 알려줘'), true);
  assert.equal(isQuestion('스쿼트 20개 했어'), false);
  assert.equal(isQuestion('휴식 60초'), false);
});

test('PLAN 15: 기간·운동 이름 찾기', () => {
  assert.equal(parseRange('어제', NOW).label, '어제');
  assert.equal(parseRange('지난주', NOW).label, '지난주');
  assert.equal(parseRange('스쿼트', NOW), null);
  assert.equal(findActivity('오늘 스쿼드 몇 개', DATA), '스쿼트'); // 오인식도 기록 이름으로
  assert.equal(topic('오늘'), '오늘은');
  assert.equal(topic('어제'), '어제는');
});

test('PLAN 15: 저장된 기록만으로 답한다', () => {
  assert.equal(answerQuestion('오늘 스쿼트 몇 개 했어', DATA, NOW), '오늘 스쿼트는 총 36개(3세트) 했어요.');
  assert.equal(answerQuestion('오늘 푸시업 몇 세트야', DATA, NOW), '오늘 푸시업은 2세트 했어요.');
  assert.match(answerQuestion('어제 뭐 했어', DATA, NOW), /^어제는 스쿼트 했어요/);
  assert.match(answerQuestion('오늘 러닝 몇 킬로 뛰었어', DATA, NOW), /5km/);
  assert.match(answerQuestion('오늘 런지 몇 개 했어', DATA, NOW), /오늘은 런지 기록이 없어요. 마지막 런지는 11월 20일에 총 40개/);
  // 11월 23일은 월요일 → 이번 주는 23일만, 22일(일)·20일(금)은 지난주
  assert.equal(answerQuestion('이번 주 스쿼트 몇 개 했어', DATA, NOW), '이번 주 스쿼트는 총 36개(3세트) 했어요.');
  assert.equal(answerQuestion('지난주 스쿼트 몇 개 했어', DATA, NOW), '지난주 스쿼트는 총 10개(1세트) 했어요.');
  assert.equal(answerQuestion('지난주 운동 몇 세트 했어', DATA, NOW), '지난주 2일 동안 운동은 3세트 했어요.');
  assert.equal(answerQuestion('오늘 뭐 했어', [], NOW), '아직 저장된 운동 기록이 없어요.');
  assert.match(answerQuestion('지난달 뭐 했어', DATA, NOW), /지난달은 운동 기록이 없어요/);
});

test('조사·운동 종료 말', () => {
  assert.equal(withRo('2분'), '2분으로');
  assert.equal(withRo('30초'), '30초로');
  assert.equal(withRo('1분 30초'), '1분 30초로');
  assert.ok(END_SESSION_RE.test('운동 끝'));
  assert.ok(END_SESSION_RE.test('운동 종료'));
  assert.equal(parseRest('휴식 종료').action, 'end'); // "종료"가 있어도 휴식 끝으로 먼저 처리
});
