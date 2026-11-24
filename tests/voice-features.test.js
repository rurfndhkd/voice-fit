import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchWake, validateWake } from '../public/js/wake.js';
import { extractCounts, currentCount, setsToEntries, SET_END_RE } from '../public/js/counting.js';
import { runWorkoutDialog, runCallDialog, classifyCallChoice } from '../public/js/dialogs.js';
import { parseLocal } from '../public/js/parser-local.js';
import { spellNumber } from '../public/js/format.js';

/* ---------- 호출어 ---------- */
test('호출어: 띄어쓰기·문장부호 무시, 뒤에 이어 말한 내용 분리', () => {
  const a = matchWake('보이스 핏!', '보이스핏');
  assert.equal(a.matched, true);
  assert.equal(a.rest, '');
  const b = matchWake('보이스핏 스쿼트 15개', '보이스핏');
  assert.equal(b.matched, true);
  assert.equal(b.rest, '스쿼트 15개');
  assert.equal(matchWake('오늘 날씨 좋다', '보이스핏').matched, false);
});
test('호출어: 4글자 이상은 한 글자 오인식 허용', () => {
  assert.equal(matchWake('보이스빗', '보이스핏').matched, true);
  assert.equal(matchWake('헤이코치', '헤이코치').matched, true);
  assert.equal(matchWake('코치', '헤이코치').matched, false);
});
test('호출어 검증', () => {
  assert.ok(validateWake('a'));
  assert.equal(validateWake('헤이 코치'), null);
});

/* ---------- 카운트 ---------- */
test('카운트: 고유어·한자어·숫자', () => {
  assert.deepEqual(extractCounts('하나 둘 셋 넷'), [1, 2, 3, 4]);
  assert.deepEqual(extractCounts('하나둘셋'), [1, 2, 3]);
  assert.deepEqual(extractCounts('열하나 열둘 스물'), [11, 12, 20]);
  assert.deepEqual(extractCounts('1 2 3'), [1, 2, 3]);
  assert.deepEqual(extractCounts('십일 십이'), [11, 12]);
  assert.deepEqual(extractCounts('세트 끝'), []);
});
test('카운트: 놓친 숫자는 건너뛰고, 큰 점프는 무시', () => {
  assert.equal(currentCount(0, '하나 둘 넷 다섯'), 5);
  assert.equal(currentCount(5, '여섯 스물'), 6);
  assert.equal(currentCount(7, '셋'), 7);
});
test('카운트: 세트 끝 / 세트를 기록으로', () => {
  assert.ok(SET_END_RE.test('세트 끝'));
  const base = { sport: '맨몸운동', activity: '스쿼트', category: '맨몸', metrics: {} };
  assert.equal(setsToEntries(base, [10, 10, 10])[0].metrics.sets, 3);
  assert.equal(setsToEntries(base, [10, 8]).length, 2);
  assert.equal(setsToEntries(base, [0]).length, 0);
});

/* ---------- 대화 ---------- */
function fakeIO(answers) {
  const said = [];
  const saved = [];
  const io = {
    said, saved,
    say: async (t) => { said.push(t); },
    listen: async () => answers.shift() ?? null,
    parse: async (text, last) => ({ result: parseLocal(text, last), source: 'local' }),
    save: (entries) => { saved.push(...entries); return entries; },
    undo: () => null,
    last: () => null,
    counting: null,
    startCount: (e) => { io.counting = e; },
  };
  return io;
}

test('대화: 호출 → 운동 → 양 → 기록', async () => {
  const io = fakeIO(['스쿼트', '15개 3세트']);
  const r = await runWorkoutDialog(io);
  assert.equal(r.status, 'saved');
  assert.match(io.said[0], /연결됐어요/);
  assert.match(io.said[1], /얼마나/);
  assert.equal(io.saved[0].metrics.reps, 15);
  assert.equal(io.saved[0].metrics.sets, 3);
});
test('대화: 한 번에 말하면 묻지 않고 기록', async () => {
  const io = fakeIO([]);
  await runWorkoutDialog(io, '푸시업 20개');
  assert.equal(io.said.length, 1);
  assert.equal(io.saved[0].metrics.reps, 20);
});
test('대화: 5초 무응답이면 운동만 기록', async () => {
  const io = fakeIO(['플랭크', null]);
  const r = await runWorkoutDialog(io);
  assert.equal(r.status, 'saved');
  assert.equal(io.saved[0].activity, '플랭크');
});
test('대화: "몰라 넘어가" 면 운동만 기록', async () => {
  const io = fakeIO(['버피', '아 몰라 넘어가']);
  await runWorkoutDialog(io);
  assert.equal(io.saved[0].activity, '버피');
  assert.equal(io.saved[0].metrics.reps, null);
});
test('대화: 운동도 말하지 않으면 취소', async () => {
  const io = fakeIO([null]);
  assert.equal((await runWorkoutDialog(io)).status, 'cancelled');
});
test('대화: "세면서 할게" → 카운트 모드', async () => {
  const io = fakeIO(['스쿼트', '세면서 할게']);
  const r = await runWorkoutDialog(io);
  assert.equal(r.status, 'counting');
  assert.equal(r.entry.activity, '스쿼트');
  assert.equal(io.saved.length, 0, '기록하지 않음');
  const r2 = await runWorkoutDialog(fakeIO([]), '런지 카운트 시작');
  assert.equal(r2.status, 'counting');
  assert.equal(r2.entry.activity, '런지');
});

/* ---------- 전화 ---------- */
test('전화번호 읽기', () => {
  assert.equal(spellNumber('010-1234-5678'), '공일공, 일이삼사, 오육칠팔');
  assert.equal(spellNumber('+821012345678'), '공일공, 일이삼사, 오육칠팔');
});
test('전화 대답 분류', () => {
  assert.equal(classifyCallChoice('받아'), 'answer');
  assert.equal(classifyCallChoice('안 받아'), 'reject');
  assert.equal(classifyCallChoice('끊어'), 'reject');
  assert.equal(classifyCallChoice('문자 남겨줘'), 'message');
  assert.equal(classifyCallChoice('음'), null);
});

function callIO(answers) {
  const log = [];
  return {
    log,
    say: async (t) => log.push(['say', t]),
    listen: async () => answers.shift() ?? null,
    answer: async () => log.push(['answer']),
    reject: async () => log.push(['reject']),
    sendSms: async (n, t) => log.push(['sms', n, t]),
  };
}
test('전화: 연락처 이름으로 안내, 문자 남기기', async () => {
  const io = callIO(['문자 남겨', '운동 중이라 이따 전화할게', '응 보내']);
  const r = await runCallDialog(io, { name: '엄마', number: '01012345678' });
  assert.equal(r.action, 'message');
  assert.match(io.log[0][1], /^엄마님에게서 전화/);
  const order = io.log.map((l) => l[0]);
  assert.ok(order.indexOf('reject') < order.indexOf('sms'), '먼저 끊고 문자');
  assert.deepEqual(io.log.find((l) => l[0] === 'sms'), ['sms', '01012345678', '운동 중이라 이따 전화할게']);
});
test('전화: 저장 안 된 번호는 번호 전체를 읽음, 받기', async () => {
  const io = callIO(['받아']);
  const r = await runCallDialog(io, { name: '', number: '01098765432' });
  assert.equal(r.action, 'answer');
  assert.match(io.log[0][1], /공일공, 구팔칠육, 오사삼이/);
});
test('전화: 대답 없으면 그대로 둠', async () => {
  const io = callIO([null]);
  assert.equal((await runCallDialog(io, { number: '0212345678' })).action, 'none');
});

/* ---------- v0.3: 호출어 민감도 ---------- */
import { matchWakeAny } from '../public/js/wake.js';
test('호출어: 비슷한 소리·받침 오인식 허용', () => {
  for (const t of ['보이스 핏', '보이스빗', '보이스피트', '보이스 피']) assert.equal(matchWake(t, '보이스핏').matched, true, t);
  for (const t of ['헤이코지', '에이 코치', '해이코치']) assert.equal(matchWake(t, '헤이 코치').matched, true, t);
});
test('호출어: 관계없는 말에는 반응하지 않음', () => {
  for (const t of ['오늘 날씨 좋다', '스쿼트 15개', '안녕하세요', '코치']) assert.equal(matchWake(t, '헤이 코치').matched, false, t);
});
test('호출어: 뒤에 이어 말한 내용은 음절 단위로 온전히 남김', () => {
  assert.equal(matchWake('보이스 피 스쿼트', '보이스핏').rest, '스쿼트');
  assert.equal(matchWake('보이스피트', '보이스핏').rest, '');
});
test('호출어: 인식 후보 중 하나만 맞아도 호출', () => {
  assert.equal(matchWakeAny(['보이 스킵', '보이스핏'], '보이스핏').matched, true);
  assert.equal(matchWakeAny(['스킵', '보이'], '보이스핏').matched, false);
});

/* ---------- v0.4: 카운트 요청 · 대화 세션 ---------- */
import { END_SESSION_RE } from '../public/js/dialogs.js';
test('카운트 요청: 개수와 함께 말해도 기록하지 않고 목표로 카운트', async () => {
  const io = fakeIO([]);
  const r = await runWorkoutDialog(io, '스쿼트 20개 카운트 시작할께', { session: true });
  assert.equal(r.status, 'counting');
  assert.equal(r.entry.activity, '스쿼트');
  assert.equal(r.goal.reps, 20);
  assert.equal(io.saved.length, 0);
  const r2 = await runWorkoutDialog(fakeIO([]), '버피 10개 3세트 시작할게', { session: true });
  assert.deepEqual([r2.status, r2.goal.reps, r2.goal.sets], ['counting', 10, 3]);
});
test('카운트 요청이 없으면 그대로 기록', async () => {
  const io = fakeIO([]);
  const r = await runWorkoutDialog(io, '스쿼트 20개', { session: true });
  assert.equal(r.status, 'saved');
  assert.equal(io.saved[0].metrics.reps, 20);
});
test('세션 안에서는 못 알아들어도 대화를 끝내지 않음', async () => {
  const io = fakeIO([]);
  const r = await runWorkoutDialog(io, '오늘 날씨 어때', { session: true });
  assert.equal(r.status, 'failed');
  assert.match(io.said[0], /다시 말씀해/);
  assert.equal(io.said.length, 1);
});
test('대화 끝내는 말', () => {
  for (const t of ['그만할게', '대화 끝', '고마워', '이제 됐어', '오늘은 여기까지', '종료']) assert.ok(END_SESSION_RE.test(t), t);
  for (const t of ['스쿼트 20개', '플랭크 1분', '한 세트 더']) assert.ok(!END_SESSION_RE.test(t), t);
});

/* ---------- v0.5: 카운트 재동기화 ---------- */
import { advanceCount } from '../public/js/counting.js';
test('카운트: 크게 뒤처져도 이어지는 숫자가 들리면 바로 따라감', () => {
  // 앱은 8인데 사용자는 이미 14, 15를 말함 → 15로 맞춤
  assert.equal(advanceCount({ count: 8, lastHeard: 8 }, '열넷 열다섯').count, 15);
  // 음성 인식이 끊겨 14와 15가 다른 결과로 따로 들어와도 따라감
  const a = advanceCount({ count: 8, lastHeard: 8 }, '14');
  assert.equal(a.count, 8, '한 번만 들린 큰 숫자는 보류');
  assert.equal(advanceCount(a, '15').count, 15);
});
test('카운트: 동떨어진 숫자 하나는 무시 (오인식 방지)', () => {
  assert.equal(advanceCount({ count: 3, lastHeard: 3 }, '스물').count, 3);
  assert.equal(advanceCount({ count: 3, lastHeard: 3 }, '넷 다섯 여섯').count, 6);
});

/* ---------- v0.6: 타이머 ---------- */
import { timerToEntries, START_SIGNAL_RE, TIMER_STOP_RE } from '../public/js/counting.js';
test('타이머: 시간으로 말하면 기록 대신 타이머', async () => {
  const io = fakeIO([]);
  const r = await runWorkoutDialog(io, '플랭크 1분 시작할게', { session: true });
  assert.equal(r.status, 'timer');
  assert.equal(r.entry.activity, '플랭크');
  assert.equal(r.durationSec, 60);
  assert.equal(io.saved.length, 0);
  assert.match(io.said[0], /1분 타이머 준비/);
  const r2 = await runWorkoutDialog(fakeIO([]), '플랭크 30초 3세트 타이머', { session: true });
  assert.deepEqual([r2.status, r2.durationSec, r2.sets], ['timer', 30, 3]);
});
test('타이머: 시간 없이 타이머만 말하면 다시 묻기', async () => {
  const r = await runWorkoutDialog(fakeIO([]), '플랭크 타이머', { session: true });
  assert.equal(r.status, 'failed');
});
test('타이머: 시간만 말하고 카운트 요청이 없으면 그대로 기록', async () => {
  const io = fakeIO([]);
  const r = await runWorkoutDialog(io, '플랭크 1분 했어', { session: true });
  assert.equal(r.status, 'saved');
  assert.equal(io.saved[0].metrics.duration_sec, 60);
});
test('타이머: 시작·멈춤 신호와 기록 변환', () => {
  assert.ok(START_SIGNAL_RE.test('시작'));
  assert.ok(TIMER_STOP_RE.test('그만'));
  const base = { sport: '맨몸운동', activity: '플랭크', category: '맨몸', metrics: {} };
  assert.deepEqual(timerToEntries(base, [60, 60, 60])[0].metrics, { reps: null, duration_sec: 60, sets: 3 });
  assert.equal(timerToEntries(base, [60, 45]).length, 2);
});

test('보안: 문자는 확인받은 뒤에만, 아니라고 하면 안 보냄', async () => {
  const io = callIO(['문자 남겨', '이따 전화할게', '아니 취소']);
  const r = await runCallDialog(io, { number: '01012345678', name: '' });
  assert.equal(r.action, 'reject');
  assert.ok(!io.log.some((x) => x[0] === 'sms'), '문자를 보내면 안 됨');
});
test('보안: 잠금 중에는 문자를 보내지 않음', async () => {
  const io = callIO(['문자 남겨', '이따 전화할게', '응']);
  io.canSms = () => false;
  const r = await runCallDialog(io, { number: '01012345678', name: '' });
  assert.equal(r.blocked, true);
  assert.ok(!io.log.some((x) => x[0] === 'sms'));
});
