// 음성 대화 흐름. 화면·음성 엔진과 분리해 두어 테스트할 수 있게 한다.
// io 는 앱이 넘겨주는 입출력:
//   say(text)            → Promise  (다 말할 때까지 기다림)
//   listen(timeoutMs)    → Promise<string|null>  (timeoutMs 동안 말이 없으면 null)
//   parse(text, last)    → Promise<{ result, source }>
//   save(entries, raw, source) → saved[]
//   undo()               → 지운 기록 | null
//   last()               → 직전 기록 | null
import { describe, hasMetrics, spellNumber } from './format.js';
import { COUNT_REQUEST_RE, TIMER_RE, stripCountWords } from './counting.js';
import { MIN_CONFIDENCE, rangeProblem } from './commands.js';

/** 말뜻이 확실하지 않음 (PLAN 6: 확신도 70% 미만이면 실행하지 않는다) */
const unsure = (r) => r.intent === 'log' && (r.confidence ?? 1) < MIN_CONFIDENCE;

export const ANSWER_TIMEOUT_MS = 5000;

export const SKIP_RE = /(몰라|모르겠|넘어가|패스|스킵|걍|그냥\s*(해|기록|넘)|됐어|아이\s*참|기록만|상관\s*없)/;

/** 대화를 끝내는 말 (대화 세션 종료) */
export const END_SESSION_RE = /(대화\s*(끝|종료|그만|마쳐|마칠)|그만\s*(할게|하자|할래|해|들어)|이제\s*(됐어|끝|그만)|종료|끝낼게|끝내자|끝내줘|수고했어|고마워|고맙습니다|나중에\s*봐|잘\s*있어|바이바이|오늘은\s*여기까지|오늘\s*(운동\s*)?끝|운동\s*(끝|마칠|마쳐|마치|그만))/;

const countGoal = (e) => ({ reps: e?.metrics?.reps || null, sets: e?.metrics?.sets || null });

function countIntro(entry, goal) {
  const target = goal?.reps ? ` ${goal.reps}개${goal.sets ? ` ${goal.sets}세트` : ''}` : '';
  return `${entry.activity}${target} 카운트를 시작할게요. 하나부터 세 주세요.${goal?.reps ? '' : ' 세트가 끝나면 “끝”이라고 말해 주세요.'}`;
}

/**
 * 운동 기록 대화 한 번.
 * - 운동과 양을 한 번에 말하면 바로 기록
 * - 운동만 말하면 "얼마나?"를 묻고, 5초 무응답·넘기기 말이면 운동만 기록
 * - "카운트 시작", "세면서 할게" 등이 들어 있으면 기록하지 않고 카운트 모드로 넘김
 *   (같이 말한 개수·세트는 목표로 쓴다: "스쿼트 20개 카운트 시작" → 목표 20개)
 * @param {{ session?: boolean }} opts session=true 면 대화 세션 안에서 호출된 것 (인사·재질문 생략)
 * @returns {Promise<{status:'saved'|'counting'|'undo'|'cancelled'|'failed', entry?, goal?, saved?}>}
 */
export async function runWorkoutDialog(io, firstUtterance = '', { session = false, parsed = null, requestedMode = null } = {}) {
  let text = String(firstUtterance || '').trim();

  if (!text) {
    await io.say('연결됐어요. 어떤 운동을 기록할까요?');
    text = await io.listen(ANSWER_TIMEOUT_MS);
    if (!text || SKIP_RE.test(text)) {
      await io.say('알겠어요. 필요하면 다시 불러 주세요.');
      return { status: 'cancelled' };
    }
  }

  const wantsTimer = requestedMode ? requestedMode === 'timer' : TIMER_RE.test(text);
  let wantsCount = requestedMode ? ['timer', 'count'].includes(requestedMode) : wantsTimer || COUNT_REQUEST_RE.test(text);
  let { result, source } = parsed || await io.parse(wantsCount ? stripCountWords(text) : text, io.last());

  if (result.intent === 'undo') {
    const removed = io.undo();
    await io.say(removed ? `${removed.activity} 기록을 지웠어요.` : '지울 기록이 없어요.');
    return { status: 'undo', removed };
  }

  if (result.intent !== 'log' || unsure(result)) {
    const heard = unsure(result) ? `“${text}”, 맞는지 확실하지 않아요. ` : '잘 못 알아들었어요. ';
    if (session) {
      await io.say(`${heard}다시 말씀해 주세요.`);
      return { status: 'failed' };
    }
    await io.say(`${heard}어떤 운동인지 다시 말씀해 주세요.`);
    const retry = await io.listen(ANSWER_TIMEOUT_MS);
    if (!retry || SKIP_RE.test(retry)) {
      await io.say('알겠어요. 필요하면 다시 불러 주세요.');
      return { status: 'cancelled' };
    }
    text = retry;
    wantsCount = COUNT_REQUEST_RE.test(text);
    ({ result, source } = await io.parse(wantsCount ? stripCountWords(text) : text, io.last()));
    if (result.intent !== 'log' || unsure(result)) {
      await io.say('죄송해요, 이해하지 못했어요. 다음에 다시 불러 주세요.');
      return { status: 'failed' };
    }
  }

  const entries = result.entries.map((e) => ({ ...e, metrics: { ...e.metrics } }));

  // 값이 허용 범위 밖이면 기록하지 않고 알려 준다 (PLAN 9: 횟수 1~1000 등)
  const bad = rangeProblem(entries);
  if (bad) {
    await io.say(bad);
    return { status: 'invalid', message: bad };
  }

  // 시간으로 말한 운동("플랭크 1분 시작할게", "30초 타이머") → 타이머를 만들고 '시작' 신호를 기다린다
  const timed = entries[0]?.metrics?.duration_sec && !entries[0]?.metrics?.reps;
  if (wantsCount && timed) {
    const entry = entries[0];
    const sec = entry.metrics.duration_sec;
    const sets = entry.metrics.sets || 1;
    const label = sec >= 60 ? `${Math.floor(sec / 60)}분${sec % 60 ? ` ${sec % 60}초` : ''}` : `${sec}초`;
    await io.say(`${entry.activity} ${label}${sets > 1 ? ` ${sets}세트` : ''} 타이머 준비됐어요. “시작”이라고 하면 바로 시작해요.`);
    return { status: 'timer', entry: { ...entry, metrics: {} }, durationSec: sec, sets };
  }
  if (wantsTimer && !timed) {
    await io.say('몇 분, 몇 초짜리 타이머인지 같이 말해 주세요. 예: 플랭크 1분 타이머');
    return { status: 'failed' };
  }

  // 카운트 요청: 기록하지 않고 카운트 모드로 (말한 개수·세트는 목표)
  if (wantsCount) {
    const entry = entries[0];
    const goal = countGoal(entry);
    await io.say(countIntro(entry, goal));
    return { status: 'counting', entry: { ...entry, metrics: {} }, goal };
  }

  const missing = entries.filter((e) => !hasMetrics(e));
  if (missing.length) {
    const target = missing[0];
    await io.say(`${target.activity}, 얼마나 했어요?`);
    const answer = await io.listen(ANSWER_TIMEOUT_MS);
    if (answer && COUNT_REQUEST_RE.test(answer) && entries.length === 1) {
      // "20개 세면서 할게" → 목표 20개로 카운트
      const second = await io.parse(`${target.activity} ${stripCountWords(answer)}`, io.last());
      if (second.result.intent !== 'log' || unsure(second.result)) {
        await io.say('목표 횟수를 정확히 듣지 못했어요. 다시 말해 주세요.');
        return { status: 'failed' };
      }
      const goal = countGoal(second.result.entries[0]);
      await io.say(countIntro(target, goal));
      return { status: 'counting', entry: { ...target, metrics: {} }, goal };
    }
    if (answer && !SKIP_RE.test(answer)) {
      const second = await io.parse(`${target.activity} ${answer}`, io.last());
      if (second.result.intent === 'undo') {
        await io.say('이번 기록은 취소할게요.');
        return { status: 'cancelled' };
      }
      const filled = second.result.intent === 'log' && !unsure(second.result) ? second.result.entries[0] : null;
      if (filled && hasMetrics(filled)) {
        target.metrics = filled.metrics;
        if (filled.note && !target.note) target.note = filled.note;
        if (second.source === 'ai') source = 'ai';
      } else {
        await io.say(second.result.reply || '숫자를 확실히 듣지 못해서 기록하지 않았어요. 다시 말해 주세요.');
        return { status: 'failed' };
      }
    }
  }

  const badAfter = rangeProblem(entries); // "얼마나 했어요?"에 대답한 숫자도 확인
  if (badAfter) {
    await io.say(badAfter);
    return { status: 'invalid', message: badAfter };
  }

  const saved = io.save(entries, text, source);
  await io.say(`${saved.map(describe).join(', ')}, 기록했어요!`);
  return { status: 'saved', saved };
}

/* ---------------- 전화 ---------------- */
const SEND_OK_RE = /(응|어|네|예|그래|보내|좋아|맞아|오케이|ok|ㅇㅇ)/i;
const SEND_NO_RE = /(아니|싫어|취소|보내지\s*마|하지\s*마|그만|다시)/;
export const callerLabel = (call) => (call?.name ? `${call.name}님` : spellNumber(call?.number));

/** 사용자의 대답을 받기 / 끊기 / 문자 중 하나로 분류 */
export function classifyCallChoice(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (!t.trim()) return null;
  if (/(문자|메시지|메세지|남겨|보내)/.test(t)) return 'message';
  if (/(끊|거절|안\s?받|받지\s?마|못\s?받|나중에|무시)/.test(t)) return 'reject';
  if (/(받아|받을|받기|받자|받어|연결|응|어 받|네|예|그래)/.test(t)) return 'answer';
  return null;
}

/**
 * 전화 수신 대화.
 * io: say, listen, answer(), reject(), sendSms(number, text), canSms?() — false 면 문자 금지(잠금 중)
 */
export async function runCallDialog(io, call) {
  const label = callerLabel(call);
  await io.say(`${label}에게서 전화가 왔어요. 받을까요, 끊을까요, 아니면 문자를 남길까요?`);

  let choice = null;
  for (let attempt = 0; attempt < 2 && !choice; attempt++) {
    const reply = await io.listen(8000);
    if (!reply) break;
    choice = classifyCallChoice(reply);
    if (!choice && attempt === 0) await io.say('받기, 끊기, 문자 중에 말해 주세요.');
  }

  if (!choice) {
    await io.say('대답이 없어서 그대로 둘게요.');
    return { action: 'none' };
  }
  if (choice === 'answer') {
    await io.answer();
    return { action: 'answer' };
  }
  if (choice === 'reject') {
    await io.reject();
    await io.say('전화를 끊었어요.');
    return { action: 'reject' };
  }

  // 보안: 잠긴 폰에서는 문자를 보내지 않는다 (주운 사람이 보내는 것 방지)
  if (io.canSms && !io.canSms()) {
    await io.reject();
    await io.say('잠금 상태라 문자는 보낼 수 없어요. 전화만 끊었어요.');
    return { action: 'reject', blocked: true };
  }
  await io.say('보낼 내용을 말씀해 주세요.');
  const message = await io.listen(10000);
  if (!message) {
    await io.reject();
    await io.say('내용이 없어서 전화만 끊었어요.');
    return { action: 'reject' };
  }
  // 보안: 잘못 들었거나 옆 사람 말일 수 있으니 읽어 주고 확인받은 뒤에만 보낸다
  await io.say(`“${message}” 라고 보낼까요?`);
  const ok = await io.listen(8000);
  if (!ok || !SEND_OK_RE.test(ok) || SEND_NO_RE.test(ok)) {
    await io.reject();
    await io.say('문자는 보내지 않고 전화만 끊었어요.');
    return { action: 'reject', cancelled: true };
  }
  await io.reject();
  let sent = true;
  try { await io.sendSms(call.number, message); } catch { sent = false; }
  await io.say(sent ? `${label}에게 문자를 보냈어요. ${message}` : '문자를 보내지 못했어요.');
  return { action: 'message', message, sent };
}
