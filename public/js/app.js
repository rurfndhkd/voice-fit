import * as store from './store.js';
import { parseLocal } from './parser-local.js';
import { transcribeWithAI, hasUserKey, getUserKey, setUserKey, clearUserKey, maskKey, looksLikeKey, testKey } from './ai.js';
import { createVoiceEngine, speak, stopSpeaking, voiceErrorText, browserRecognitionSupported, recordingSupported } from './speech.js';
import { THEMES, applyTheme } from './themes.js';
import { CATEGORIES } from './schema.js';
import { metricChips, formatNumber } from './format.js';
import { matchWake, matchWakeAny, validateWake } from './wake.js';
import { runWorkoutDialog, runCallDialog, callerLabel, ANSWER_TIMEOUT_MS, END_SESSION_RE } from './dialogs.js';
import { advanceCount, setsToEntries, timerToEntries, SET_END_RE, WORKOUT_END_RE, START_SIGNAL_RE, TIMER_STOP_RE, TIMER_CANCEL_RE } from './counting.js';
import * as phone from './phone.js';
import { isNative } from './config.js';
import { backgroundSupported, bgStatus, bgStart, bgStop, bgRequestPermissions, bgMoveToBack, bgListen, bgSession, bgUnlock, bgOpenBattery, bgRestAlarm } from './background.js';
import { understand } from './understand.js';
import { micPickSupported, listMics, setMic, onMicsChanged, micIcon, micSummary } from './mic.js';
import { parseRest, parseSeconds, restLabel, withRo, REST_MIN, REST_MAX, isNegatedControl } from './commands.js';
import { summarize, duration } from './summary.js';
import { isQuestion, answerQuestion } from './answer.js';
import { planWithAI } from './intent.js';
import { describe } from './format.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  settings: store.getSettings(),
  ai: false,
  voice: null,
  voiceBlocked: false,
  filter: '전체',
  count: null, // { entry, sets: number[], current: number }
  locked: false, // 잠금화면 위에 떠 있는지 (설정·기록은 잠금 해제 후)
};

/**
 * 음성 제어 상태.
 * mode: idle | wake(호출어 대기) | dialog(대화 중) | count(카운트) | call(전화 응대) | in-call(통화 중)
 * session 이 바뀌면 진행 중이던 대화·듣기는 모두 중단된다.
 */
const ctl = { mode: 'idle', session: 0, pending: null, queued: null, speaking: false, lastSpokeAt: 0, signal: null, undoIds: null, callHandled: false, afterCall: null, inSession: false, sessionFromBg: false, screenOff: false, stats: null };
const recentTurns = [];
let intentRequest = null;

/** 잘못 들린 말 바로잡기에 쓰는 문맥: 지난 기록의 운동 이름, 지금 하는 운동 */
function understandCtx() {
  const history = [...new Set(store.getEntries().slice(-200).map((e) => String(e.activity || '').replace(/\s+/g, '')))];
  return { history, activity: state.count?.entry?.activity || store.lastEntry()?.activity || '' };
}

/** 음성으로 들린 말을 문맥으로 바로잡는다 (인식 후보 여러 개 활용) */
function heardText(t) {
  if (state.ai) return t; // Let the semantic model see the original words, especially negation/numbers.
  return understand(t, state.voice?.candidates || [], understandCtx()).text || t;
}

class Aborted extends Error {}
const isAborted = (e) => e instanceof Aborted;
const guard = (token) => { if (token !== ctl.session) throw new Aborted(); };
const canUseVoice = () => Boolean(state.voice) && !state.voiceBlocked;

function interrupt() {
  ctl.session++;
  intentRequest?.abort();
  state.voice?.cancel();
  stopSpeaking();
  ctl.speaking = false;
  ctl.queued = null;
  if (ctl.pending) { const p = ctl.pending; ctl.pending = null; p.resolve(null); }
}

/** 대화 도중(AI가 말하거나 해석 중일 때) 들어온 대답은 다음 질문의 대답으로 쓴다. 말하던 건 끊는다. */
function queueAnswer(text) {
  (ctl.queued ||= []).push(text);
  stopSpeaking();
}

function markVoiceError(e) {
  if (['not-allowed', 'service-not-allowed', 'audio-capture', 'start-failed'].includes(e?.code)) {
    if (!state.voiceBlocked) toast(voiceErrorText(e));
    state.voiceBlocked = true;
    renderStatus();
  }
}

/* ================= 말하기 · 듣기 ================= */
async function say(text, token) {
  guard(token);
  addBubble('ai', text);
  if (ctl.mode === 'call' || ctl.mode === 'in-call') $('#callStatus').textContent = text;
  ctl.speaking = true;
  state.voice?.cancel(); // 내 목소리를 듣지 않도록
  try {
    if (state.settings.voiceFeedback) await speak(text, state.settings.rate, { cloud: state.ai && state.settings.naturalVoice && ctl.mode === 'dialog' });
    else await sleep(250);
  } finally {
    ctl.speaking = false;
    ctl.lastSpokeAt = Date.now();
  }
  guard(token);
}

/**
 * timeoutMs 동안 대답을 기다린다. 음성과 입력창(또는 버튼) 중 먼저 온 것을 쓴다.
 * 말하는 중이거나 입력창에 타이핑 중이면 대기 시간이 연장된다.
 */
function listen(timeoutMs, token) {
  guard(token);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const pending = {};
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ctl.pending === pending) ctl.pending = null;
      state.voice?.cancel();
      setMicVisual();
      if (token !== ctl.session) { reject(new Aborted()); return; }
      const text = typeof v === 'string' && v.trim() ? v.trim() : null;
      if (text) addBubble('user', text);
      $('#transcript').textContent = '';
      resolve(text);
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => done(null), timeoutMs); };
    pending.resolve = done;
    pending.activity = arm;
    if (ctl.queued?.length) {
      const q = ctl.queued.shift();
      if (!ctl.queued.length) ctl.queued = null;
      done(q);
      return;
    }
    ctl.pending = pending;
    // 마이크가 실제로 열리기까지 걸리는 시간만큼 여유를 주고, 열린 순간(onReady)부터 다시 센다
    clearTimeout(timer);
    timer = setTimeout(() => done(null), timeoutMs + (canUseVoice() ? 2000 : 0));
    setMicVisual('listening');

    const startVoice = () => {
      if (settled || !canUseVoice()) return;
      state.voice.listenOnce({
        timeoutMs,
        context: ctl.mode === 'call' ? '' : understandCtx().activity,
        onReady: arm,
        onSpeech: () => { clearTimeout(timer); timer = setTimeout(() => done(null), 35000); },
        onProcessing: () => { clearTimeout(timer); timer = setTimeout(() => done(null), 35000); setMicVisual('processing'); },
        onLevel: setMicLevel,
        onInterim: (t) => { arm(); $('#transcript').textContent = t; },
      })
        .then((t) => { if (t) done(heardText(t)); else if (!settled) setTimeout(startVoice, 120); })
        .catch((e) => { markVoiceError(e); toast(voiceErrorText(e)); done(null); });
    };
    startVoice();
  });
}

/* ================= 대화 ================= */
async function aiParse(text, last, token) {
  setMicVisual('processing');
  let result = null;
  let source = 'local';
  if (state.ai) {
    const plan = await planWithAI(text, { last, turns: recentTurns, mode: 'followup' });
    guard(token);
    const a = plan?.actions?.[0];
    result = a && plan.actions.length === 1 && ['log', 'undo'].includes(a.kind)
      ? { intent: a.kind, entries: a.entries, confidence: plan.confidence, reply: a.reply }
      : { intent: 'unknown', entries: [], confidence: 0, reply: a?.reply || '' };
    source = 'ai';
  }
  guard(token);
  if (!result) result = parseLocal(text, last);
  return { result, source };
}

function dialogIO(token) {
  return {
    say: (t) => say(t, token),
    listen: (ms) => listen(ms, token),
    parse: (text, last) => aiParse(text, last, token),
    save: (entries, raw, source) => {
      const saved = store.addEntries(entries, raw, source);
      ctl.undoIds = saved.map((e) => e.id);
      renderAll();
      return saved;
    },
    undo: () => {
      const last = store.lastEntry();
      if (last) { store.removeEntries([last.id]); renderAll(); }
      return last;
    },
    last: () => store.lastEntry(),
    startCount: () => {}, // 대화가 끝나면 아래 startDialog 가 카운트 모드로 넘긴다
  };
}

/**
 * @param {boolean} fromBackground 홈 화면(백그라운드)에서 호출돼 앱이 열린 경우.
 *        대화가 끝나면 원래 보던 화면으로 돌아간다.
 */
/**
 * 대화 세션: 호출 뒤에는 "그만/대화 끝/고마워" 같은 말이나 마이크(취소) 버튼 전까지 계속 이어진다.
 * 한 번 기록해도 끝나지 않고 다음 말을 기다린다. 카운트 모드도 이 세션 안에서 돈다.
 * @param {boolean} fromBackground 홈 화면(백그라운드)에서 호출돼 앱이 열린 경우 — 끝나면 원래 화면으로 돌아간다
 * @param {boolean} resumeCount 전화·화면 전환으로 멈췄던 카운트를 이어서 할 때
 */
async function startDialog(first = '', { showUser = true, fromBackground = false, resumeCount = false, resumed = false } = {}) {
  interrupt();
  const token = ctl.session;
  ctl.mode = 'dialog';
  ctl.inSession = true;
  ctl.sessionFromBg = fromBackground;
  // 이번 운동 한 번(세션)의 시작 시각·휴식 시간 — 끝나면 결과 요약에 쓴다 (PLAN 13)
  ctl.stats ||= { startedAt: Date.now(), startIso: new Date().toISOString(), restSec: 0 };
  bgSession(true); // 세션 중에는 화면이 꺼져도 계속 듣고, 잠금화면 위에 보인다
  renderStatus();
  setMicVisual();
  // 호출어와 함께 말한 내용도 문맥으로 바로잡는다 (예: "스쿼드 20개 세자" → 스쿼트)
  let utterance = first ? (state.ai ? first : understand(first, [], understandCtx()).text) : '';
  if (utterance && showUser) addBubble('user', utterance);
  let greeted = resumeCount || resumed;

  try {
    if (resumeCount && state.count) await runCount(token);
    while (token === ctl.session) {
      if (!utterance) {
        // 부르면 짧게 바로 대답하고 곧장 듣는다
        if (!greeted) { await say('네, 말씀하세요.', token); greeted = true; }
        ctl.mode = 'dialog';
        renderStatus();
        // 말이 없으면 조용히 계속 기다린다 (끝내는 말이나 버튼 전까지)
        utterance = await listen(30000, token);
        if (!utterance) continue;
      }
      greeted = true;
      if (state.ai) {
        const raw = utterance;
        utterance = '';
        try {
          intentRequest = new AbortController();
          setMicVisual('processing');
          const last = store.lastEntry();
          const plan = await planWithAI(raw, { last, turns: recentTurns, mode: ctl.mode, signal: intentRequest.signal });
          guard(token);
          if (plan && await executePlan(plan, raw, token, last?.id)) break;
        } catch (e) {
          guard(token);
          await say(voiceErrorText(e), token);
        } finally { intentRequest = null; }
        continue;
      }
      // PLAN 12: "휴식 60초" / "휴식 끝"
      const restCmd = parseRest(utterance);
      if (restCmd) {
        utterance = '';
        if ((await handleRest(token, restCmd)) === 'quit') { await say('운동을 마칠게요.', token); break; }
        continue;
      }
      // PLAN 15: "오늘 스쿼트 몇 개 했어?" → 저장된 기록만으로 답한다
      if (isQuestion(utterance)) {
        const q = utterance;
        utterance = '';
        setMicVisual('processing');
        await say(answerQuestion(q, store.getEntries()), token);
        continue;
      }
      if (END_SESSION_RE.test(utterance)) {
        await say('대화를 마칠게요. 필요하면 다시 불러 주세요.', token);
        break;
      }
      const r = await runWorkoutDialog(dialogIO(token), utterance, { session: true });
      utterance = '';
      if (r?.status === 'timer') {
        await runTimer(token, r);
        continue;
      }
      if (r?.status === 'counting') {
        state.count = { entry: r.entry, goal: r.goal || {}, sets: [], current: 0, done: false };
        await runCount(token);
      }
    }
  } catch (e) {
    if (isAborted(e)) return;
    console.error(e);
    toast('처리 중 문제가 생겼어요');
  }
  if (token !== ctl.session) return;
  endSession();
}

/** Execute a validated semantic plan. All confirmations come from actual application results. */
async function executePlan(plan, raw, token, lastId) {
  for (const action of plan.actions) {
    guard(token);
    const io = dialogIO(token);
    if (['chat', 'clarify'].includes(action.kind)) {
      await say(action.reply || '조금 더 구체적으로 말해 주세요.', token);
    } else if (action.kind === 'question') {
      await say(answerQuestion(action.query || raw, store.getEntries()), token);
    } else if (action.kind === 'end') {
      await say('대화를 마칠게요. 필요하면 다시 불러 주세요.', token);
      return true;
    } else if (action.kind === 'rest' || action.kind === 'rest_end') {
      const quit = await handleRest(token, { action: action.kind === 'rest_end' ? 'end' : 'start', seconds: action.seconds, problem: null });
      if (quit === 'quit') return true;
    } else if (action.kind === 'undo') {
      const removed = io.undo();
      await say(removed ? `${removed.activity} 기록을 지웠어요.` : '지울 기록이 없어요.', token);
    } else if (action.kind === 'correct') {
      const updated = store.correctLastEntry(lastId, action.entries[0], raw);
      renderAll();
      await say(updated ? `${describe(updated)}로 고쳤어요.` : '바꿀 마지막 기록을 확인하지 못했어요.', token);
    } else {
      const r = await runWorkoutDialog(io, raw, { session: true, requestedMode: action.kind,
        parsed: { source: 'ai', result: { intent: 'log', confidence: plan.confidence, entries: action.entries } } });
      if (r?.status === 'timer') await runTimer(token, r);
      else if (r?.status === 'counting') {
        state.count = { entry: r.entry, goal: r.goal || {}, sets: [], current: 0, done: false };
        await runCount(token);
      } else if (['failed', 'cancelled', 'invalid'].includes(r?.status)) return false;
    }
  }
  return false;
}

/** 마이크 버튼으로 대화를 끝냄. 세고 있던 카운트는 버리지 않고 조용히 저장한다 */
function cancelSession() {
  interrupt();
  const c = state.count;
  if (c) {
    const all = c.current > 0 ? [...c.sets, c.current] : c.sets;
    const entries = setsToEntries(c.entry, all);
    if (entries.length) { store.addEntries(entries, `${c.entry.activity} 카운트`, 'count'); renderAll(); }
    state.count = null;
    renderCounter();
  }
  addBubble('sys', '대화를 마쳤어요');
  endSession();
}

/** 세션 종료: 백그라운드 호출이었다면 원래 화면으로, 아니면 다시 호출어 대기 */
async function endSession() {
  const fromBg = ctl.sessionFromBg;
  ctl.inSession = false;
  ctl.sessionFromBg = false;
  await showSessionSummary(); // PLAN 13: 이번 운동에 기록이 있으면 결과 요약
  await bgSession(false);
  if (fromBg && backgroundSupported()) {
    interrupt();
    ctl.mode = 'background';
    await bgMoveToBack(); // 잠금화면에서 불렀다면 다시 잠금화면으로
    return;
  }
  if (ctl.screenOff) {
    // 화면이 꺼진 채 대화가 끝남: 호출어 듣기는 서비스에 넘긴다
    interrupt();
    ctl.mode = 'background';
    setMicLevel(0);
    return;
  }
  resume();
}

/* ================= 백그라운드 (안드로이드 앱) ================= */
async function syncBackgroundService() {
  if (!backgroundSupported()) return;
  const s = state.settings;
  if (s.listenMode && s.wakeWord && s.backgroundListen) await bgStart(s.wakeWord, { enabled: s.noiseGate, level: s.gateLevel, voiceLock: s.voiceLock });
  else await bgStop();
  renderBgCard();
}

function onAppState(active, info = {}) {
  setLocked(Boolean(info.locked));
  if (!active) {
    // 앱이 가려짐: 앱 안의 듣기를 멈춘다(서비스가 이어서 듣는다). 전화 응대 중이면 그대로 둔다.
    if (ctl.mode === 'call' || ctl.mode === 'in-call') return;
    // 운동 중 화면만 꺼진 경우: 대화·카운트·타이머를 그대로 이어간다 (화면 없이도 듣고 대답)
    if (info.screenOff && ctl.inSession) { ctl.screenOff = true; return; }
    ctl.screenOff = Boolean(info.screenOff);
    interrupt();
    ctl.inSession = false; // 홈 버튼 등으로 나감: 세션을 멈추고 서비스가 호출어를 듣는다 (카운트는 돌아오면 이어서)
    bgSession(false);
    ctl.mode = 'background';
    setMicLevel(0);
    return;
  }
  ctl.screenOff = false;
  renderBgCard();
  // 백그라운드 호출로 열린 경우에는 이미 대화가 시작돼 있다
  if (ctl.mode !== 'background') return;
  if (state.count) startDialog('', { resumeCount: true });
  else resume();
}

function onBackgroundWake(rest) {
  showView('home');
  startDialog(rest, { showUser: Boolean(rest), fromBackground: true });
}

async function renderBgCard() {
  if (!backgroundSupported()) return;
  const s = await bgStatus();
  $('#bgCard').hidden = false;
  $('#bgToggle').checked = state.settings.backgroundListen;
  $('#bgOverlay').textContent = s.overlay ? '허용됨' : '허용 필요';
  $('#bgNotif').textContent = s.notifications ? '허용됨' : '허용 필요';
  $('#bgRunning').textContent = s.running ? '듣는 중' : '꺼짐';
  $('#bgBattery').textContent = s.battery ? '(꺼짐 · 화면 꺼져도 호출 OK)' : '(켜짐 · 화면 꺼지면 놓칠 수 있음)';
  $('#bgBatteryToggle').checked = Boolean(s.battery);
  $('#bgPermBtn').hidden = s.overlay && s.notifications;
}

/** 대화·카운트·전화가 끝나면: 듣기 모드면 다시 호출어를 기다린다 */
function resume() {
  interrupt();
  const token = ctl.session;
  const listenOn = state.settings.listenMode && state.settings.wakeWord && canUseVoice();
  ctl.mode = listenOn ? 'wake' : 'idle';
  renderStatus();
  setMicVisual();
  if (listenOn) wakeLoop(token);
}

async function wakeLoop(token) {
  const wake = state.settings.wakeWord;
  while (token === ctl.session && ctl.mode === 'wake') {
    let text = null;
    let stopTimer = null;
    const startedAt = Date.now();
    try {
      text = await state.voice.listenOnce({
        timeoutMs: 0,
        mode: 'wake',
        onLevel: setMicLevel,
        onInterim: (t) => {
          $('#transcript').textContent = t;
          // 중간 결과에 호출어가 들리면, 이어지는 말이 없을 때(0.5초) 바로 마무리해서 빠르게 반응한다
          clearTimeout(stopTimer);
          if (matchWake(t, wake).matched) stopTimer = setTimeout(() => state.voice?.stop?.(), 1500);
        },
      });
    } catch (e) {
      markVoiceError(e);
      if (state.voiceBlocked) { setListenMode(false); return; }
      await sleep(1000);
      continue;
    } finally {
      clearTimeout(stopTimer);
      setMicLevel(0);
    }
    if (token !== ctl.session) return;
    $('#transcript').textContent = '';
    // 최종 문장 + 인식 후보 + 중간 결과를 모두 비교 (민감도 ↑)
    const candidates = [text, ...(state.voice?.candidates || [])].filter(Boolean);
    const m = matchWakeAny(candidates, wake);
    if (m.matched) {
      // 나머지 말은 가장 그럴듯한 최종 문장 기준
      const rest = text ? matchWake(text, wake).rest : '';
      startDialog(m.matched && rest ? rest : '', { showUser: Boolean(rest) });
      return;
    }
    // 오류로 즉시 끝난 경우 너무 빠르게 반복하지 않게
    await sleep(Date.now() - startedAt < 500 ? 400 : 100);
  }
}

/** 마이크 입력 크기를 버튼 테두리로 보여준다 (안드로이드 앱) */
function setMicLevel(level) {
  const n = Number(level);
  const v = Math.max(0, Math.min(20, (n + 2) * 1.6));
  $('#micBtn').style.setProperty('--lvl', `${v.toFixed(1)}px`);
  // 설정 화면의 음성 감지 막대: 기준선을 넘으면 초록색
  const fill = $('#gateFill');
  if (fill) {
    fill.style.width = `${gatePct(n)}%`;
    fill.classList.toggle('pass', n >= state.settings.gateLevel);
  }
}

/* ================= 내 목소리만 듣기 (목소리 등록) ================= */
const ENROLL_SENTENCE = '보이스핏, 오늘도 같이 운동하자. 하나, 둘, 셋, 넷, 다섯.';

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** 두 문장이 얼마나 비슷한지 0~1 (글자 두 개씩 묶어 겹치는 비율) */
function textSimilarity(a, b) {
  const norm = (x) => String(x || '').replace(/[^\p{L}\p{N}]/gu, '');
  const grams = (x) => { const n = norm(x); const g = new Set(); for (let i = 0; i < n.length - 1; i++) g.add(n.slice(i, i + 2)); return g; };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of B) if (A.has(g)) hit++;
  return hit / B.size;
}

async function renderVoiceCard() {
  const supported = Boolean(state.voice?.enrollVoice);
  const st = supported ? await state.voice.voiceStatus() : { enrolled: false };
  state.voiceEnrolled = Boolean(st.enrolled);
  $('#voiceState').textContent = !supported ? '안드로이드 앱 전용'
    : st.enrolled ? `등록됨 (${new Date(st.savedAt).toLocaleDateString('ko-KR')})` : '등록 안 됨';
  $('#voiceLockToggle').disabled = !st.enrolled;
  $('#voiceLockToggle').checked = Boolean(st.enrolled && state.settings.voiceLock);
  $('#voiceEnrollBtn').disabled = !supported;
  $('#voiceEnrollBtn').textContent = st.enrolled ? '다시 등록하기' : '내 목소리 등록하기';
  $('#voiceClearBtn').hidden = !st.enrolled;
  $('#voiceHint').textContent = st.captureSupported === false
    ? '이 기기는 음성 인식에 걸러진 소리를 직접 넘길 수 없어, 내 목소리만 듣기 대신 소리 크기 기준으로만 걸러요.'
    : '';
  $('#voiceBanner').hidden = !supported || st.enrolled || state.settings.voiceBannerDismissed;
}

async function enrollMyVoice() {
  if (!state.voice?.enrollVoice || !canUseVoice()) { toast('안드로이드 앱에서 마이크를 쓸 수 있을 때 등록할 수 있어요'); return; }
  showView('home');
  interrupt();
  const token = ctl.session;
  ctl.mode = 'dialog';
  renderStatus();
  try {
    await say('내 목소리를 등록할게요. 화면의 문장을 평소 목소리로 읽어 주세요.', token);
    addBubble('sys', `읽을 문장: “${ENROLL_SENTENCE}”`);
    await say('지금 읽어 주세요.', token);
    setMicVisual('listening');
    const r = await state.voice.enrollVoice(7000);
    setMicLevel(0);
    guard(token);
    if (!r?.ok) {
      await say('목소리가 충분히 들리지 않았어요. 폰을 입 가까이 두고 다시 해 주세요.', token);
    } else {
      // 내 키가 있으면 AI 가 등록 녹음을 한 번 듣고, 문장을 또렷하게 읽었는지 확인한다
      let verified = null;
      if (hasUserKey()) {
        setMicVisual('processing');
        const heard = await transcribeWithAI(base64ToBlob(r.wav, 'audio/wav')).catch(() => null);
        guard(token);
        verified = heard !== null && textSimilarity(heard, ENROLL_SENTENCE) >= 0.45;
        if (!verified) {
          await state.voice.clearVoice();
          addBubble('sys', `AI 가 들은 문장: “${heard || '(알아듣지 못함)'}”`);
          await say('AI 가 문장을 또렷하게 알아듣지 못했어요. 조용한 곳에서 다시 해 주세요.', token);
        }
      }
      if (verified !== false) {
        state.settings = store.saveSettings({ voiceLock: true });
        applyGate();
        syncBackgroundService();
        await say(verified ? 'AI 확인까지 끝났어요. 이제 내 목소리만 들을게요.' : '등록했어요. 이제 내 목소리만 들을게요.', token);
      }
    }
  } catch (e) {
    if (isAborted(e)) return;
    console.error(e);
    toast('등록 중 문제가 생겼어요');
  }
  await renderVoiceCard();
  resume();
}

function initVoiceCard() {
  $('#voiceEnrollBtn').onclick = () => enrollMyVoice();
  $('#voiceBannerBtn').onclick = () => enrollMyVoice();
  $('#voiceBannerLater').onclick = () => {
    state.settings = store.saveSettings({ voiceBannerDismissed: true });
    $('#voiceBanner').hidden = true;
  };
  $('#voiceLockToggle').onchange = async (e) => {
    state.settings = store.saveSettings({ voiceLock: e.target.checked });
    applyGate();
    await syncBackgroundService();
  };
  $('#voiceClearBtn').onclick = async () => {
    if (!confirm('등록한 내 목소리를 지울까요?')) return;
    await state.voice?.clearVoice?.();
    state.settings = store.saveSettings({ voiceLock: false });
    applyGate();
    await syncBackgroundService();
    await renderVoiceCard();
    toast('목소리 등록을 지웠어요');
  };
  renderVoiceCard();
}

/* ================= 주변 소리 배제 (음성 감지 기준) ================= */
const GATE_MIN = -2;
const GATE_MAX = 12;
const gatePct = (level) => Math.max(0, Math.min(100, ((Number(level) - GATE_MIN) / (GATE_MAX - GATE_MIN)) * 100));

function applyGate() {
  const s = state.settings;
  state.voice?.setGate?.({ enabled: s.noiseGate, level: s.gateLevel, voiceLock: s.voiceLock });
  $('#gateMark').style.left = `calc(${gatePct(s.gateLevel)}% - 1px)`;
  $('#gateValue').textContent = s.gateLevel.toFixed(1);
  $('#gateToggle').checked = s.noiseGate;
  $('#gateLevel').value = s.gateLevel;
}

function initGateCard() {
  const supported = Boolean(state.voice?.gateSupported);
  $('#gateToggle').disabled = !supported;
  $('#gateLevel').disabled = !supported;
  $('#gateCalibrateBtn').disabled = !supported;
  if (!supported) $('#gateHint').textContent = '브라우저에서는 마이크 소리 크기를 알 수 없어, 이 기능은 안드로이드 앱에서만 동작해요.';
  applyGate();
  $('#gateToggle').onchange = async (e) => {
    state.settings = store.saveSettings({ noiseGate: e.target.checked });
    applyGate();
    await syncBackgroundService();
  };
  $('#gateLevel').oninput = (e) => {
    state.settings = store.saveSettings({ gateLevel: Number(e.target.value) });
    applyGate();
  };
  $('#gateLevel').onchange = () => syncBackgroundService();
  $('#gateCalibrateBtn').onclick = () => calibrateGate();
}

/** ms 동안 마이크 음량을 모은다 (음성 인식이 중간에 끝나도 다시 켜서 계속 잰다) */
async function measureLevels(ms, token) {
  const out = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    guard(token);
    const stop = setTimeout(() => state.voice?.cancel(), Math.max(0, end - Date.now()));
    try {
      await state.voice.listenOnce({ mode: 'calibrate', timeoutMs: 0, onLevel: (l) => { out.push(Number(l)); setMicLevel(l); } });
    } catch { await sleep(200); } finally { clearTimeout(stop); }
  }
  return out;
}

const percentile = (arr, p) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};

/** 내 목소리로 자동 맞추기: 주변 소음 3초 → 내 목소리 5초를 재서 그 사이에 기준을 둔다 */
async function calibrateGate() {
  if (!canUseVoice() || !state.voice?.gateSupported) { toast('안드로이드 앱에서 마이크를 쓸 수 있을 때만 맞출 수 있어요'); return; }
  interrupt();
  const token = ctl.session;
  ctl.mode = 'dialog';
  renderStatus();
  $('#gateCalibrateBtn').disabled = true;
  try {
    await say('주변 소리를 재 볼게요. 3초 동안 조용히 해 주세요.', token);
    const noise = percentile(await measureLevels(3000, token), 0.9);
    await say('이제 평소처럼 하나, 둘, 셋, 넷, 다섯 하고 세 주세요.', token);
    const voice = percentile(await measureLevels(5000, token), 0.85);
    if (noise === null || voice === null) {
      await say('소리를 재지 못했어요. 다시 시도해 주세요.', token);
    } else if (voice - noise < 1.5) {
      await say('목소리와 주변 소리 차이가 작아요. 폰을 입에 더 가깝게 두고 다시 해 주세요.', token);
    } else {
      const level = Math.round((noise + (voice - noise) * 0.45) * 2) / 2;
      state.settings = store.saveSettings({ gateLevel: level, noiseGate: true });
      applyGate();
      syncBackgroundService();
      await say('맞췄어요. 이제 내 목소리보다 작은 주변 소리는 무시할게요.', token);
      toast(`주변 소음 ${noise.toFixed(1)} · 내 목소리 ${voice.toFixed(1)} → 기준 ${level.toFixed(1)}`);
    }
  } catch (e) {
    if (isAborted(e)) return;
    console.error(e);
  } finally {
    $('#gateCalibrateBtn').disabled = false;
  }
  resume();
}

async function setListenMode(on) {
  if (on && !state.settings.wakeWord) {
    toast('먼저 호출어를 등록해 주세요');
    showView('home');
    enrollWake();
    return;
  }
  if (on && !canUseVoice()) {
    toast('이 환경에서는 마이크를 쓸 수 없어요. 입력창에 호출어를 써도 돼요.');
  }
  state.settings = store.saveSettings({ listenMode: on });
  await phone.keepScreenOn(on);
  await syncBackgroundService();
  if (ctl.mode === 'idle' || ctl.mode === 'wake') resume();
  else renderStatus();
}

async function enrollWake() {
  interrupt();
  const token = ctl.session;
  ctl.mode = 'dialog';
  renderStatus();
  try {
    await say('등록할 호출어를 말해 주세요.', token);
    const word = await listen(7000, token);
    if (!word) {
      await say('들리지 않았어요. 다시 시도해 주세요.', token);
    } else {
      const clean = word.replace(/[.!?,~"']/g, '').trim();
      const err = validateWake(clean);
      if (err) await say(err, token);
      else {
        saveWake(clean);
        await say(`“${clean}”(으)로 등록했어요. 이제 ${clean} 하고 불러 주세요.`, token);
      }
    }
  } catch (e) {
    if (isAborted(e)) return;
    throw e;
  }
  resume();
}

function saveWake(word) {
  state.settings = store.saveSettings({ wakeWord: word });
  renderWake();
  renderStatus();
  syncBackgroundService();
}

/* ================= 타이머 ================= */
/** 가볍고 짧은 알림음 한 번 (끝나면 바로 멈춤) */
let audioCtx = null;
function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1320, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.35);
  } catch { /* 소리를 낼 수 없는 환경 */ }
}

/**
 * 말(중간 결과 포함)·입력창·버튼으로 들어온 신호를 기다린다. match(text) 가 값을 돌려주면 즉시 끝난다.
 * 중간 결과에서 바로 판정하므로 "시작"이라고 말하는 순간 반응한다.
 */
function waitSignal(token, match) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sig = {};
    const finish = (v) => {
      if (done) return;
      done = true;
      if (ctl.signal === sig) ctl.signal = null;
      state.voice?.cancel();
      resolve(v);
    };
    sig.feed = (txt) => { if (isNegatedControl(txt)) return; const v = match(String(txt || '')); if (v) finish(v); };
    sig.cancel = () => finish(null);
    ctl.signal = sig;
    (async () => {
      while (!done) {
        if (token !== ctl.session) { done = true; reject(new Aborted()); return; }
        if (!canUseVoice()) { await sleep(150); continue; }
        while (ctl.speaking && !done) await sleep(50);
        try {
          const txt = await state.voice.listenOnce({
            timeoutMs: 0,
            mode: 'signal',
            onLevel: setMicLevel,
            onInterim: (x) => { $('#transcript').textContent = x; },
          });
          if (txt) sig.feed(txt);
        } catch (e) {
          markVoiceError(e);
          await sleep(300);
        }
      }
    })();
  });
}

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function renderTimer() {
  const t = state.timer;
  $('#timer').hidden = !t;
  if (!t) return;
  const left = t.phase === 'running'
    ? Math.max(0, t.durationSec - (performance.now() - t.startAt) / 1000)
    : t.durationSec;
  $('#timerValue').textContent = fmtClock(Math.ceil(left));
  $('#timerActivity').textContent = t.entry.activity;
  $('#timerSets').textContent = `${t.results.length + 1}/${t.sets}세트 · ${t.phase === 'running' ? '진행 중 (“그만”이면 멈춤)' : '“시작”이라고 말하면 바로 시작'}`;
  $('#timerStartBtn').hidden = t.phase === 'running';
  $('#timerStopBtn').hidden = t.phase !== 'running';
  $('#timer').classList.toggle('running', t.phase === 'running');
}

/**
 * 시간 운동 타이머: 준비 → "시작" 신호를 받는 즉시 시작 → 끝나면 짧은 알림음 한 번 → 기록.
 * 진행 중 "그만"이면 그때까지 한 시간으로 기록한다.
 */
async function runTimer(token, { entry, durationSec, sets }) {
  const t = { entry, durationSec, sets: Math.max(1, sets || 1), results: [], phase: 'ready', startAt: 0 };
  state.timer = t;
  ctl.mode = 'timer';
  renderStatus();
  renderTimer();
  let cancelled = false;
  try {
    while (t.results.length < t.sets) {
      t.phase = 'ready';
      renderTimer();
      const cmd = await waitSignal(token, (x) => (TIMER_CANCEL_RE.test(x) ? 'cancel' : START_SIGNAL_RE.test(x) ? 'start' : null));
      if (cmd === 'cancel') { cancelled = true; break; }
      t.phase = 'running';
      t.startAt = performance.now();
      renderTimer();
      const tick = setInterval(renderTimer, 200);
      let timeUp;
      const ended = new Promise((r) => { timeUp = setTimeout(() => r('done'), durationSec * 1000); });
      const stopped = waitSignal(token, (x) => (TIMER_STOP_RE.test(x) ? 'stop' : null));
      const how = await Promise.race([ended, stopped]);
      clearInterval(tick);
      clearTimeout(timeUp);
      ctl.signal?.cancel();
      const elapsed = how === 'done' ? durationSec : Math.round((performance.now() - t.startAt) / 1000);
      beep();
      t.results.push(elapsed);
      if (how === 'stop') break;
      if (t.results.length < t.sets) addBubble('sys', `${t.results.length}세트 완료 · 다음 세트는 “시작”이라고 하면 바로 시작해요`);
    }
  } finally {
    state.timer = null;
    renderTimer();
    ctl.mode = 'dialog';
    renderStatus();
  }
  const entries = timerToEntries(entry, t.results);
  if (!entries.length) {
    if (cancelled) await say('타이머를 취소했어요.', token);
    return;
  }
  const saved = store.addEntries(entries, `${entry.activity} 타이머`, 'timer');
  ctl.undoIds = saved.map((e) => e.id);
  renderAll();
  const total = t.results.reduce((a, b) => a + b, 0);
  addBubble('ai', `${entry.activity} ${t.results.length}세트, 총 ${fmtClock(total)} 기록했어요`);
}

/* ================= 휴식 타이머 (PLAN 12) ================= */
// 앱(네이티브)이 종료 시각에 알림음을 내면 이 함수가 불린다 → 화면이 꺼져 웹 타이머가 늦어도 제시간에 끝낸다
let restDoneNow = null;
const onRestDone = () => restDoneNow?.();

function renderRest() {
  const r = state.rest;
  $('#rest').hidden = !r;
  if (!r) return;
  const left = Math.max(0, (r.endAt - Date.now()) / 1000);
  $('#restValue').textContent = fmtClock(Math.ceil(left));
  $('#restInfo').textContent = `${restLabel(r.total)} 휴식 · “휴식 끝”이면 바로 끝, 다른 시간을 말하면 바꿔요`;
}

/** "휴식 …" 명령 처리. 'quit' 를 돌려주면 운동(세션)을 끝낸다 */
async function handleRest(token, cmd) {
  if (cmd.action === 'end') { await say('지금은 휴식 중이 아니에요.', token); return null; }
  if (cmd.problem) { await say(cmd.problem, token); return null; }
  let seconds = cmd.seconds;
  if (seconds === null) {
    await say(`몇 초 쉴까요? ${REST_MIN}초에서 ${REST_MAX}초 사이로 말해 주세요.`, token);
    const ans = await listen(ANSWER_TIMEOUT_MS * 2, token);
    seconds = ans ? parseSeconds(/[초분]/.test(ans) ? ans : `${ans}초`) : null;
    if (!seconds) { await say('휴식 시간을 못 들었어요. “휴식 60초”처럼 말해 주세요.', token); return null; }
    if (seconds < REST_MIN || seconds > REST_MAX) { await say(`휴식은 ${REST_MIN}초에서 ${REST_MAX}초(5분) 사이로 말해 주세요.`, token); return null; }
  }
  return runRest(token, seconds);
}

/**
 * 휴식 타이머: 말한 순간부터 바로 센다. 끝나면 알림음 + "휴식 끝" 음성 (±2초 목표).
 * 쉬는 중 "휴식 끝" → 바로 끝, 다른 시간 → 새 시간으로 교체, "운동 끝" → 운동 종료.
 * 실제로 쉰 시간만 이번 운동의 휴식 시간에 더한다.
 */
async function runRest(token, seconds) {
  const prevMode = ctl.mode;
  let total = seconds;
  let startAt = Date.now();
  let rested = 0;
  let outcome = null;
  state.rest = { endAt: startAt + total * 1000, total };
  ctl.mode = 'rest';
  renderStatus();
  renderRest();
  const native = await bgRestAlarm(total * 1000);
  const tick = setInterval(renderRest, 250);
  say(`휴식 ${restLabel(total)} 시작할게요.`, token).catch(() => {});
  try {
    for (;;) {
      let timeUp;
      const done = new Promise((r) => {
        timeUp = setTimeout(() => r({ type: 'done' }), Math.max(0, state.rest.endAt - Date.now()));
        restDoneNow = () => r({ type: 'done' });
      });
      const heard = waitSignal(token, (x) => {
        const c = parseRest(x);
        if (c?.action === 'end') return { type: 'end' };
        if (c?.action === 'start' && (c.seconds || c.problem)) return { type: 'new', c };
        if (END_SESSION_RE.test(x)) return { type: 'quit' };
        return null;
      });
      const ev = await Promise.race([done, heard]);
      clearTimeout(timeUp);
      restDoneNow = null;
      if (ctl.signal) ctl.signal.cancel();
      guard(token);
      if (ev?.type === 'new') {
        if (ev.c.problem) { await say(ev.c.problem, token); continue; }
        rested += (Date.now() - startAt) / 1000;
        startAt = Date.now();
        total = ev.c.seconds;
        state.rest = { endAt: startAt + total * 1000, total };
        if (native) await bgRestAlarm(total * 1000);
        renderRest();
        say(`휴식을 ${withRo(restLabel(total))} 바꿨어요.`, token).catch(() => {});
        continue;
      }
      if (!ev) continue; // 다른 입력으로 신호만 취소된 경우: 남은 시간 계속
      rested += Math.min(total, (Date.now() - startAt) / 1000);
      outcome = ev.type;
      break;
    }
  } finally {
    clearInterval(tick);
    restDoneNow = null;
    if (outcome !== 'done') bgRestAlarm(0);
    state.rest = null;
    renderRest();
    if (ctl.stats) ctl.stats.restSec += rested;
    if (ctl.mode === 'rest') ctl.mode = prevMode === 'count' ? 'count' : 'dialog';
    renderStatus();
  }
  if (outcome === 'done') {
    if (!native) beep(); // 앱에서는 네이티브가 제시간에 이미 울렸다
    $('#rest').classList.add('ending');
    setTimeout(() => $('#rest').classList.remove('ending'), 1600);
    await say('휴식 끝! 다음 세트 시작하세요.', token);
  } else if (outcome === 'end') {
    await say(`휴식을 끝낼게요. ${duration(rested)} 쉬었어요.`, token);
  }
  return outcome === 'quit' ? 'quit' : null;
}

/* ================= 결과 요약 (PLAN 13) ================= */
async function showSessionSummary() {
  const st = ctl.stats;
  ctl.stats = null;
  if (!st) return;
  const entries = store.getEntries().filter((e) => String(e.date) >= st.startIso);
  if (!entries.length) return;
  const sum = summarize(entries, { startedAt: st.startedAt, endedAt: Date.now(), restSec: st.restSec });
  const hm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  $('#summaryWhen').textContent = `${hm(st.startedAt)} ~ ${hm(Date.now())}`;
  $('#summaryList').innerHTML = sum.items.map((i) => `<li><b>${esc(i.activity)}</b><span>${esc(i.text)}</span>${i.detail ? `<small>세트별 ${esc(i.detail)}개</small>` : ''}</li>`).join('');
  $('#sumTotal').textContent = duration(sum.totalSec);
  $('#sumRest').textContent = duration(sum.restSec);
  $('#summarySheet').hidden = false;
  addBubble('ai', sum.spoken);
  if (state.settings.voiceFeedback) await speak(sum.spoken, state.settings.rate).catch(() => {});
}

function closeSummary() {
  $('#summarySheet').hidden = true;
  showView('home');
}

/* ================= 카운트 모드 ================= */
/**
 * 대화 세션 안에서 카운트를 진행한다. "운동 끝"(또는 목표 세트 완료·운동 끝 버튼)까지 돌고, 끝나면 기록을 저장한다.
 * state.count = { entry, goal: { reps, sets }, sets: number[], current, done }
 */
async function runCount(token) {
  const c = state.count;
  if (!c) return;
  const carried = ctl.queued?.join(' '); // 안내를 말하는 도중에 이미 세기 시작한 경우
  ctl.queued = null;
  ctl.mode = 'count';
  renderCounter();
  renderStatus();
  setMicVisual('listening');
  if (carried) await handleCountText({ count: c.current, lastHeard: c.lastHeard ?? null }, carried, token);

  while (state.count && !state.count.done) {
    guard(token);
    // 세는 중 "휴식 60초"(말·입력창): 지금 세트를 마치고 휴식 → 끝나면 다음 세트를 이어서 센다 (PLAN 12)
    if (state.count.pendingRest) {
      const cmd = state.count.pendingRest;
      state.count.pendingRest = null;
      if (cmd.action === 'start' && !cmd.problem && cmd.seconds) await finishSet(token);
      if (state.count && !state.count.done) {
        const r = await handleRest(token, cmd);
        if (r === 'quit' && state.count) state.count.done = true;
        ctl.mode = 'count';
        renderCounter();
        renderStatus();
        setMicVisual('listening');
      }
      continue;
    }
    if (!canUseVoice()) { await sleep(200); continue; } // 버튼·입력창으로 진행
    while (ctl.speaking) { guard(token); await sleep(100); }
    const base = { count: state.count.current, lastHeard: state.count.lastHeard ?? null };
    // 직전 듣기가 막 끝났고 그 사이 앱이 말하지 않았다면, 다시 시작하는 틈에 들어온 소리(최대 1초)를 이어서 넣는다
    const keepBacklog = Date.now() - lastCountEnd < 1500 && ctl.lastSpokeAt < lastCountEnd;
    let text = null;
    try {
      text = await state.voice.listenOnce({
        timeoutMs: 0,
        keepBacklog,
        mode: 'count', // 쉬어도 끊기지 않게 + 기기 안 음성인식 우선 (지연 감소)
        onLevel: setMicLevel,
        onInterim: (t) => {
          applyCountText(base, t, false);
          // 목표 개수에 닿으면 바로 마무리해서 "완료"를 빨리 알려 준다
          if (state.count?.goal?.reps && state.count.current >= state.count.goal.reps) state.voice?.stop?.();
        },
      });
    } catch (e) {
      markVoiceError(e);
      await sleep(500);
      continue;
    } finally {
      lastCountEnd = Date.now();
    }
    guard(token);
    if (text) await handleCountText(base, text, token);
    else await checkGoal(token);
  }
  guard(token);
  await saveCount(token);
}

let lastCountEnd = 0;

/** 최종 문장 반영 + 세트 끝/운동 끝/목표 달성 처리 */
async function handleCountText(base, text, token) {
  const action = applyCountText(base, text, true);
  if (action === 'rest') return; // 카운트 루프가 세트를 마치고 휴식을 돌린다
  if (action === 'workout') { if (state.count) state.count.done = true; return; }
  if (action === 'set') { await finishSet(token); return; }
  await checkGoal(token);
}

async function checkGoal(token) {
  const c = state.count;
  if (c?.goal?.reps && c.current >= c.goal.reps) await finishSet(token);
}

/**
 * 센 소리를 반영. 중간 결과는 들릴 때마다 바로 반영하고(지연 최소화),
 * 최종 결과에서는 '직전에 들린 숫자'를 저장해 다음 인식과 이어지게 한다.
 * @param base {count, lastHeard} 이번 듣기를 시작할 때의 상태
 * @returns final 이면 'set' | 'workout' | null
 */
function applyCountText(base, text, final) {
  const c = state.count;
  if (!c) return null;
  $('#transcript').textContent = text;
  // "휴식 60초"의 60을 개수로 세지 않는다. 최종 문장이면 세트를 마치고 휴식으로 (PLAN 12)
  if (isNegatedControl(text)) return null;
  const restCmd = parseRest(text);
  if (restCmd) {
    if (final) c.pendingRest = restCmd;
    return final ? 'rest' : null;
  }
  const endW = WORKOUT_END_RE.exec(text);
  const endS = SET_END_RE.exec(text);
  const cut = Math.min(endW?.index ?? Infinity, endS?.index ?? Infinity);
  const before = cut === Infinity ? text : text.slice(0, cut);
  const r = advanceCount(base, before);
  if (r.count > c.current) { c.current = r.count; renderCounter(true); }
  if (!final) return null;
  c.lastHeard = r.lastHeard;
  return endW ? 'workout' : endS ? 'set' : null;
}

async function finishSet(token = ctl.session) {
  const c = state.count;
  if (!c) return;
  const n = c.current;
  if (n > 0) c.sets.push(n);
  c.current = 0;
  c.lastHeard = null; // 새 세트는 하나부터
  renderCounter();
  if (!n) return;
  const goalSets = c.goal?.sets;
  if (goalSets && c.sets.length >= goalSets) {
    c.done = true; // 목표 세트를 다 했으면 저장으로
    return;
  }
  const next = goalSets ? ` ${goalSets - c.sets.length}세트 남았어요.` : '';
  await say(`${n}개, ${c.sets.length}세트 완료!${next}`, token);
}

async function saveCount(token) {
  const c = state.count;
  if (!c) return;
  const all = c.current > 0 ? [...c.sets, c.current] : c.sets;
  state.count = null;
  renderCounter();
  ctl.mode = 'dialog';
  renderStatus();
  const entries = setsToEntries(c.entry, all);
  if (!entries.length) {
    await say('센 개수가 없어서 기록하지 않았어요. 다음 운동을 말해 주세요.', token);
    return;
  }
  const saved = store.addEntries(entries, `${c.entry.activity} 카운트`, 'count');
  ctl.undoIds = saved.map((e) => e.id);
  renderAll();
  const total = all.reduce((a, b) => a + b, 0);
  await say(`${c.entry.activity} ${all.length}세트, 총 ${total}개 기록했어요! 다음 운동도 말해 주세요.`, token);
}

/** 운동 끝 버튼 / 입력: 카운트를 끝내고 저장 (세션 루프가 저장한다) */
function endCountWorkout() {
  if (!state.count) return;
  state.count.done = true;
  state.voice?.cancel();
  // 세션 밖(마이크를 못 쓰는 환경 등)에서는 직접 세션을 다시 돌려 저장시킨다
  if (!ctl.inSession) startDialog('', { resumeCount: true });
}

/** 카운트 모드 버튼: 어떤 운동을 셀지 묻고 세션 안에서 카운트 시작 */
async function startCountDialog() {
  interrupt();
  const token = ctl.session;
  ctl.mode = 'dialog';
  renderStatus();
  try {
    await say('어떤 운동을 셀까요?', token);
    const t = await listen(ANSWER_TIMEOUT_MS * 2, token);
    if (!t) { await say('알겠어요. 필요하면 다시 눌러 주세요.', token); resume(); return; }
    startDialog(`${t} 카운트 시작`, { showUser: false });
  } catch (e) {
    if (!isAborted(e)) throw e;
  }
}

/* ================= 전화 ================= */
async function handleIncomingCall(call) {
  // 대화 세션·카운트 중이었다면 통화 처리 후 이어서 한다
  ctl.afterCall = { session: ctl.inSession, fromBg: ctl.sessionFromBg };
  interrupt();
  const token = ctl.session;
  ctl.mode = 'call';
  ctl.callHandled = false;
  renderStatus();
  showCallSheet(call);
  await phone.setRingerMuted(true);

  let r = null;
  try {
    r = await runCallDialog({
      say: (t) => say(t, token),
      listen: (ms) => listen(ms, token),
      answer: async () => { ctl.callHandled = true; await phone.setRingerMuted(false); await phone.answerCall(); },
      reject: async () => { ctl.callHandled = true; await phone.rejectCall(); },
      canSms: () => !state.locked,
      sendSms: async (number, text) => {
        await phone.sendSms(number, text);
        addBubble('sms', `${phone.phoneMode() === 'demo' ? '문자 전송 (시연)' : '문자 전송'} → ${callerLabel(call)} (${formatNumber(call.number)})\n“${text}”`);
      },
    }, call);
  } catch (e) {
    if (!isAborted(e)) { console.error(e); toast('전화 처리 중 문제가 생겼어요'); }
  }
  await phone.setRingerMuted(false);
  if (token !== ctl.session) return;

  if (r?.action === 'answer') {
    ctl.mode = 'in-call';
    renderStatus();
    $('#callStatus').textContent = '통화 중이에요. 통화가 끝나면 다시 들을게요.';
    if (phone.phoneMode() === 'demo') { await sleep(1800); if (ctl.mode === 'in-call') endCallFlow(); }
    return;
  }
  endCallFlow();
}

function endCallFlow() {
  hideCallSheet();
  const after = ctl.afterCall || {};
  ctl.afterCall = null;
  if (after.session || state.count) {
    startDialog('', { resumeCount: Boolean(state.count), resumed: true, fromBackground: Boolean(after.fromBg) });
  } else {
    resume();
  }
}

phone.onIncomingCall((call) => handleIncomingCall(call));
phone.onCallEnded(() => {
  // 상대가 먼저 끊었거나(아직 고르기 전), 받은 통화가 끝났을 때
  if (ctl.mode === 'in-call' || (ctl.mode === 'call' && !ctl.callHandled)) {
    const wasRinging = ctl.mode === 'call';
    interrupt();
    if (wasRinging) toast('상대방이 전화를 끊었어요');
    endCallFlow();
  }
});

function showCallSheet(call) {
  $('#callName').textContent = call.name || formatNumber(call.number) || '알 수 없는 번호';
  $('#callNumber').textContent = call.name ? formatNumber(call.number) : '저장되지 않은 번호';
  $('#callStatus').textContent = '';
  const demo = phone.phoneMode() === 'demo';
  $('#callMode').textContent = demo ? '시연 모드' : '실제 전화';
  $('#callMode').classList.toggle('ai', !demo);
  $('#callSheet').hidden = false;
}
function hideCallSheet() { $('#callSheet').hidden = true; }

/* ================= 화면 ================= */
const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>';
const SOURCE_LABEL = { ai: ' · AI 해석', count: ' · 카운트' };
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const todayKey = () => dayKey(new Date().toISOString());

function entryHTML(e, { selecting = false, selected = false } = {}) {
  const chips = metricChips(e.metrics).map((c) => `<span class="metric">${esc(c)}</span>`).join('');
  const sport = e.sport && e.sport !== e.activity ? `${esc(e.sport)} · ` : '';
  const check = selecting
    ? `<input class="entry-check" type="checkbox" data-select="${esc(e.id)}" ${selected ? 'checked' : ''} aria-label="${esc(e.activity)} 선택" />`
    : '';
  const action = selecting
    ? ''
    : `<button class="icon-btn" type="button" data-delete="${esc(e.id)}" aria-label="${esc(e.activity)} 기록 삭제">${TRASH}</button>`;
  return `<li class="entry${selecting ? ' selectable' : ''}${selected ? ' selected' : ''}"${selecting ? ` data-select-row="${esc(e.id)}"` : ''}>
    ${check}
    <div class="entry-body">
      <div class="entry-title">${esc(e.activity)} <span class="tag">${esc(e.category)}</span></div>
      <div class="entry-meta">${sport}${timeOf(e.date)}${SOURCE_LABEL[e.source] || ''}</div>
      ${chips ? `<div class="metrics">${chips}</div>` : ''}
      ${e.note ? `<div class="entry-note">${esc(e.note)}</div>` : ''}
    </div>
    ${action}
  </li>`;
}

/* ---------- 오늘 기록 지우기: 전체 삭제 / 골라서 삭제 (지운 뒤 되돌리기 가능) ---------- */
const sel = { on: false, ids: new Set() };
const todayEntries = () => store.getEntries().filter((e) => dayKey(e.date) === todayKey());

function setSelecting(on) {
  sel.on = on;
  sel.ids.clear();
  renderToday();
}

function deleteWithUndo(ids, label) {
  const set = new Set(ids);
  const removed = store.getEntries().filter((e) => set.has(e.id));
  if (!removed.length) return;
  store.removeEntries([...set]);
  sel.on = false;
  sel.ids.clear();
  renderAll();
  toast(`${label} ${removed.length}개를 지웠어요`, { label: '되돌리기', onClick: () => { store.restoreEntries(removed); renderAll(); toast('되돌렸어요'); } });
}

function renderToday() {
  const today = todayEntries().reverse();
  if (!today.length) sel.on = false;
  for (const id of sel.ids) if (!today.some((e) => e.id === id)) sel.ids.delete(id);
  $('#todayCount').textContent = today.length ? `${today.length}개` : '';
  $('#todayActions').hidden = !today.length || sel.on;
  $('#selectBar').hidden = !sel.on;
  $('#selectCount').textContent = `${sel.ids.size}개 선택`;
  $('#deleteSelectedBtn').disabled = !sel.ids.size;
  $('#deleteSelectedBtn').textContent = sel.ids.size ? `${sel.ids.size}개 삭제` : '삭제';
  $('#selectAll').checked = Boolean(today.length) && sel.ids.size === today.length;
  $('#todayList').innerHTML = today.length
    ? today.map((e) => entryHTML(e, { selecting: sel.on, selected: sel.ids.has(e.id) })).join('')
    : '<li class="empty">아직 오늘 기록이 없어요.<br/>마이크를 누르거나 호출어로 불러 보세요.</li>';
  const sets = today.reduce((a, e) => a + (e.metrics.sets || (e.metrics.reps || e.metrics.rounds ? 1 : 0)), 0);
  const secs = today.reduce((a, e) => a + (e.metrics.duration_sec || 0) * (e.metrics.rounds || 1), 0);
  const kinds = new Set(today.map((e) => e.activity)).size;
  $('#todaySummary').innerHTML = today.length
    ? `<div class="stat"><b>${kinds}</b><span>운동 종류</span></div>
       <div class="stat"><b>${sets}</b><span>총 세트</span></div>
       <div class="stat"><b>${secs ? Math.round(secs / 60) : 0}</b><span>운동 시간(분)</span></div>`
    : '';
}

function renderHistory() {
  const all = store.getEntries();
  const cats = ['전체', ...CATEGORIES.filter((c) => all.some((e) => e.category === c))];
  if (!cats.includes(state.filter)) state.filter = '전체';
  $('#catFilter').innerHTML = cats
    .map((c) => `<button class="chip" type="button" data-cat="${esc(c)}" aria-pressed="${c === state.filter}">${esc(c)}</button>`)
    .join('');
  const list = all.filter((e) => state.filter === '전체' || e.category === state.filter).reverse();
  if (!list.length) { $('#historyList').innerHTML = '<div class="empty">기록이 없어요.</div>'; return; }
  const groups = new Map();
  for (const e of list) {
    const k = dayKey(e.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  $('#historyList').innerHTML = [...groups].map(([k, items]) => {
    const label = k === todayKey() ? '오늘' : new Date(`${k}T00:00:00`).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    return `<div class="day-head">${esc(label)}<span>${items.length}개</span></div><ul class="entry-list">${items.map((e) => entryHTML(e)).join('')}</ul>`;
  }).join('');
}

function renderAll() { renderToday(); renderHistory(); }

function renderCounter(bump = false) {
  const c = state.count;
  $('#counter').hidden = !c;
  if (!c) return;
  const goalReps = c.goal?.reps;
  const goalSets = c.goal?.sets;
  $('#counterActivity').textContent = c.entry.activity;
  $('#counterValue').textContent = c.current;
  $('#counterGoal').textContent = goalReps ? `/ ${goalReps}` : '';
  const done = c.sets.map((n, i) => `${i + 1}세트 ${n}개`).join(' · ');
  const now = `${c.sets.length + 1}${goalSets ? `/${goalSets}` : ''}세트 진행 중`;
  $('#counterSets').textContent = done ? `${done} · ${now}` : now;
  if (bump) {
    const num = $('.counter-num');
    num.classList.remove('bump');
    void num.offsetWidth;
    num.classList.add('bump');
  }
}

function renderStatus() {
  const wake = state.settings.wakeWord;
  const on = Boolean(state.settings.listenMode && wake);
  $('#listenBtn').setAttribute('aria-pressed', String(on));
  $('#listenLabel').textContent = on ? '호출어 듣는 중' : '호출어 듣기';
  const text = {
    idle: wake ? (on && !canUseVoice() ? `마이크를 쓸 수 없어요 · 입력창에 “${wake}”` : `호출어: “${wake}”`) : '설정에서 호출어를 등록하세요',
    wake: `“${wake}” 하고 불러 보세요`,
    dialog: '대화 중 · 계속 듣고 있어요 (“그만” 또는 마이크 버튼으로 끝)',
    count: '카운트 중 · 소리 내어 세 주세요 (마이크 버튼 = 저장하고 끝)',
    timer: '타이머 · “시작”이라고 하면 바로 시작, “그만”이면 멈춤',
    rest: '휴식 중 · “휴식 끝”이면 바로 끝, 다른 시간을 말하면 바꿔요',
    call: '전화 응대 중',
    'in-call': '통화 중',
  }[ctl.mode];
  $('#listenStatus').textContent = text;
}

function setMicVisual(kind) {
  const btn = $('#micBtn');
  const k = kind || (ctl.mode === 'wake' ? 'wake' : 'idle');
  btn.classList.toggle('listening', k === 'listening');
  btn.classList.toggle('processing', k === 'processing');
  btn.classList.toggle('wake', k === 'wake');
  const label = {
    idle: '눌러서 말하기',
    wake: '호출어를 기다리는 중',
    listening: canUseVoice() ? '듣고 있어요…' : '입력창에 대답해 주세요',
    processing: '해석 중…',
  }[k];
  const inConvo = ctl.mode === 'dialog' || ctl.mode === 'count' || ctl.mode === 'timer';
  $('#micState').textContent = inConvo && k !== 'processing' ? `${label} · 누르면 대화 끝` : label;
  btn.setAttribute('aria-label', inConvo ? '대화 끝내기' : '말하기');
  btn.classList.toggle('in-convo', inConvo);
}

function addBubble(kind, text) {
  if (['user', 'ai'].includes(kind)) {
    recentTurns.push({ role: kind === 'ai' ? 'assistant' : 'user', text: String(text).slice(0, 300) });
    if (recentTurns.length > 8) recentTurns.shift();
  }
  const box = $('#convo');
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  if (kind === 'sms') el.style.whiteSpace = 'pre-line';
  if (kind === 'ai' && ctl.undoIds) {
    const ids = ctl.undoIds;
    ctl.undoIds = null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost small';
    b.textContent = '되돌리기';
    b.onclick = () => { store.removeEntries(ids); renderAll(); b.remove(); toast('기록을 되돌렸어요'); };
    el.append(b);
  }
  box.append(el);
  while (box.children.length > 8) box.firstElementChild.remove();
}

let toastTimer;
/** 알림. action 을 주면 버튼(예: 되돌리기)을 붙이고 조금 더 오래 보여 준다 */
function toast(msg, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('has-action', Boolean(action));
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-btn';
    b.textContent = action.label;
    b.onclick = () => { el.classList.remove('show', 'has-action'); action.onClick(); };
    el.append(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show', 'has-action'), action ? 6000 : 2600);
}

function showView(name) {
  // 잠금화면 위에서는 운동 화면만. 설정·기록은 잠금을 풀어야 열린다 (남이 폰을 집어 들어도 안전하게)
  if (state.locked && name !== 'home') {
    bgUnlock().then((ok) => {
      if (!ok) { toast('잠금을 풀면 열 수 있어요'); return; }
      setLocked(false);
      showView(name);
    });
    return;
  }
  for (const v of document.querySelectorAll('.view')) {
    const on = v.id === `view-${name}`;
    v.hidden = !on;
    v.classList.toggle('active', on);
  }
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-current', on ? 'page' : 'false');
  }
  if (name === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}

/* ================= 입력 처리 ================= */
function handleTyped(raw) {
  const text = raw.trim();
  if (!text) return;
  if (ctl.pending) { ctl.pending.resolve(text); return; }
  if ((ctl.mode === 'timer' || ctl.mode === 'rest') && ctl.signal) { addBubble('user', text); ctl.signal.feed(text); return; }
  if (ctl.mode === 'count' && state.count) {
    const action = applyCountText({ count: state.count.current, lastHeard: state.count.lastHeard ?? null }, text, true);
    if (action === 'workout') endCountWorkout();
    else if (action === 'rest') state.voice?.cancel(); // 카운트 루프가 바로 휴식으로 넘어가게
    else if (action === 'set') finishSet().catch(() => {});
    else checkGoal(ctl.session).catch(() => {});
    return;
  }
  if (ctl.mode === 'dialog' || ctl.mode === 'call') { queueAnswer(text); return; }
  if (ctl.mode === 'in-call') return;
  const wake = state.settings.wakeWord;
  if (wake) {
    const m = matchWake(text, wake);
    if (m.matched) { addBubble('user', text); startDialog(m.rest, { showUser: false }); return; }
  }
  startDialog(text);
}

$('#textForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  handleTyped($('#textInput').value);
  $('#textInput').value = '';
});
$('#textInput').addEventListener('input', () => ctl.pending?.activity());
$('#callMsgForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('#callMsgInput').value.trim();
  $('#callMsgInput').value = '';
  if (!v) return;
  if (ctl.pending) ctl.pending.resolve(v);
  else if (ctl.mode === 'call') queueAnswer(v);
});
$('#callMsgInput').addEventListener('input', () => ctl.pending?.activity());

$('#micBtn').addEventListener('click', async () => {
  // 대화·카운트 중에는 마이크 버튼 = 대화 끝내기
  if (ctl.mode === 'dialog' || ctl.mode === 'count' || ctl.mode === 'timer' || ctl.mode === 'rest') { cancelSession(); return; }
  if (ctl.mode === 'call' || ctl.mode === 'in-call') return;
  if (!canUseVoice()) {
    toast(state.voiceBlocked ? '마이크를 쓸 수 없어요. 입력창을 써 주세요.' : '이 브라우저는 음성 입력을 지원하지 않아요.');
    $('#textInput').focus();
    return;
  }
  interrupt();
  const token = ctl.session;
  ctl.mode = 'dialog';
  renderStatus();
  try {
    const t = await listen(6000, token);
    if (token !== ctl.session) return;
    if (t) startDialog(t, { showUser: false });
    else resume();
  } catch (e) { if (!isAborted(e)) throw e; }
});

$('#listenBtn').addEventListener('click', () => setListenMode(!(state.settings.listenMode && state.settings.wakeWord)));
$('#countBtn').addEventListener('click', () => {
  if (ctl.mode === 'count') { endCountWorkout(); return; }
  startCountDialog();
});

// 휴식 끝 버튼 / 결과 요약 닫기
$('#restEndBtn').addEventListener('click', () => ctl.signal?.feed('휴식 끝'));
$('#summaryHomeBtn').addEventListener('click', closeSummary);

// 오늘 기록 지우기
$('#todaySelectBtn').addEventListener('click', async () => { if (await requireUnlock()) setSelecting(true); });
$('#selectCancelBtn').addEventListener('click', () => setSelecting(false));
$('#selectAll').addEventListener('change', (e) => {
  sel.ids = new Set(e.target.checked ? todayEntries().map((x) => x.id) : []);
  renderToday();
});
$('#deleteSelectedBtn').addEventListener('click', () => {
  if (!sel.ids.size) return;
  if (!confirm(`선택한 기록 ${sel.ids.size}개를 지울까요?`)) return;
  deleteWithUndo([...sel.ids], '선택한 기록');
});
$('#todayClearBtn').addEventListener('click', async () => {
  if (!(await requireUnlock())) return;
  const ids = todayEntries().map((x) => x.id);
  if (!ids.length) return;
  if (!confirm(`오늘 기록 ${ids.length}개를 모두 지울까요?`)) return;
  deleteWithUndo(ids, '오늘 기록');
});

document.addEventListener('click', (ev) => {
  const del = ev.target.closest('[data-delete]');
  if (del) { requireUnlock().then((ok) => ok && deleteWithUndo([del.dataset.delete], '기록')); return; }
  const row = sel.on && ev.target.closest('[data-select-row]');
  if (row) {
    const id = row.dataset.selectRow;
    if (sel.ids.has(id)) sel.ids.delete(id); else sel.ids.add(id);
    renderToday();
    return;
  }
  const chip = ev.target.closest('[data-cat]');
  if (chip) { state.filter = chip.dataset.cat; renderHistory(); return; }
  const tab = ev.target.closest('.tab');
  if (tab) { showView(tab.dataset.view); return; }
  const cnt = ev.target.closest('[data-count]');
  if (cnt && state.count) {
    const a = cnt.dataset.count;
    if (a === '+1') { state.count.current++; renderCounter(true); }
    else if (a === '-1') { state.count.current = Math.max(0, state.count.current - 1); renderCounter(); }
    else if (a === 'set') finishSet().catch(() => {});
    else if (a === 'end') endCountWorkout();
    return;
  }
  const tm = ev.target.closest('[data-timer]');
  if (tm && ctl.signal) { ctl.signal.feed(tm.dataset.timer === 'start' ? '시작' : '그만'); return; }
  const callBtn = ev.target.closest('[data-call]');
  if (callBtn) {
    if (ctl.pending) ctl.pending.resolve(callBtn.dataset.call);
    else if (ctl.mode === 'call') queueAnswer(callBtn.dataset.call);
  }
});

/* ================= 설정 ================= */
function renderWake() {
  $('#wakeCurrent').textContent = state.settings.wakeWord || '없음';
}

function renderThemePicker() {
  $('#themePicker').innerHTML = THEMES.map((t) => `
    <button class="theme-opt" type="button" role="radio" data-theme-id="${t.id}" aria-checked="${t.id === state.settings.theme}">
      <span class="swatch" style="background: linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)"></span>${esc(t.name)}
    </button>`).join('');
}

function setupVoice() {
  state.voice?.cancel();
  state.voice = createVoiceEngine(state.settings.engine, state.ai);
  state.voiceBlocked = false;
  const names = { native: '기기 기본 음성 인식', 'native-openai': 'OpenAI 고정확도 인식 · 호출어/카운트는 기기 인식', browser: '브라우저 내장 음성인식', openai: 'OpenAI 고정확도 인식' };
  $('#engineInfo').textContent = state.voice
    ? `현재 사용 중: ${names[state.voice.kind]}`
    : '이 환경은 음성 입력을 지원하지 않아요. 입력창을 사용하세요.';
  state.voice?.setGate?.({ enabled: state.settings.noiseGate, level: state.settings.gateLevel, voiceLock: state.settings.voiceLock });
}

/* ================= AI 목소리 켜기/끄기 (기본 꺼짐, 추가 사용료) ================= */
function renderNaturalVoice() {
  const on = Boolean(state.settings.naturalVoice);
  $('#naturalVoice').checked = on;
  const btn = $('#aiVoiceBtn');
  btn.textContent = on ? 'AI 목소리 켜짐' : 'AI 목소리 꺼짐';
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('on', on);
}
function setNaturalVoice(on) {
  state.settings = store.saveSettings({ naturalVoice: Boolean(on) });
  renderNaturalVoice();
  if (on && !state.ai) toast('AI 목소리는 설정에 OpenAI 키를 넣어야 나와요. 그 전에는 기기 목소리로 안내해요');
  else toast(on ? 'AI 목소리를 켰어요 (사용량만큼 내 키로 과금돼요)' : 'AI 목소리를 껐어요. 기기 목소리로 안내해요');
}
$('#aiVoiceBtn').addEventListener('click', () => setNaturalVoice(!state.settings.naturalVoice));

async function initSettings() {
  applyTheme(state.settings.theme);
  renderThemePicker();
  renderWake();
  $('#voiceFeedback').checked = state.settings.voiceFeedback;
  renderNaturalVoice();
  $('#naturalVoice').onchange = (e) => setNaturalVoice(e.target.checked);
  $('#rate').value = state.settings.rate;
  $('#rateValue').textContent = `${state.settings.rate}x`;
  $('#engine').value = state.settings.engine;
  if (!browserRecognitionSupported && !isNative) $('#engine option[value="browser"]').disabled = true;
  if (!recordingSupported && !isNative) $('#engine option[value="openai"]').disabled = true;

  $('#themePicker').addEventListener('click', (ev) => {
    const opt = ev.target.closest('[data-theme-id]');
    if (!opt) return;
    state.settings = store.saveSettings({ theme: applyTheme(opt.dataset.themeId) });
    renderThemePicker();
  });
  $('#voiceFeedback').onchange = (e) => { state.settings = store.saveSettings({ voiceFeedback: e.target.checked }); };
  $('#rate').oninput = (e) => {
    const rate = Number(e.target.value);
    $('#rateValue').textContent = `${rate}x`;
    state.settings = store.saveSettings({ rate });
  };
  $('#rate').onchange = () => { if (state.settings.voiceFeedback) speak('이 속도로 말할게요.', state.settings.rate); };
  $('#engine').onchange = (e) => { state.settings = store.saveSettings({ engine: e.target.value }); setupVoice(); resume(); };

  $('#wakeEnrollBtn').onclick = () => { showView('home'); enrollWake(); };
  $('#wakeForm').onsubmit = (ev) => {
    ev.preventDefault();
    const w = $('#wakeInput').value.trim();
    const err = validateWake(w);
    if (err) { toast(err); return; }
    saveWake(w);
    $('#wakeInput').value = '';
    toast(`호출어를 “${w}”(으)로 저장했어요`);
    if (ctl.mode === 'idle' || ctl.mode === 'wake') resume();
  };

  // 전화
  if (phone.phoneMode() === 'native') {
    $('#phoneNative').hidden = false;
    $('#phoneDemo').hidden = true;
    const showPerm = async () => { $('#phonePermState').textContent = (await phone.phonePermissionState()) ? '허용됨' : '허용 필요'; };
    showPerm();
    $('#phonePermBtn').onclick = async () => {
      const r = await phone.requestPhonePermissions();
      toast(r.granted ? '전화 응대를 켰어요' : '일부 권한이 거부됐어요');
      showPerm();
    };
  }
  $('#demoCallBtn').onclick = () => {
    const number = $('#demoNumber').value.trim();
    if (!number.replace(/\D/g, '')) { toast('번호를 입력해 주세요'); return; }
    showView('home');
    setTimeout(() => phone.simulateIncomingCall({ number, name: $('#demoName').value.trim() }), 300);
  };

  initKeyCard();

  if (backgroundSupported()) {
    $('#bgToggle').onchange = async (e) => {
      state.settings = store.saveSettings({ backgroundListen: e.target.checked });
      await syncBackgroundService();
    };
    $('#bgPermBtn').onclick = async () => {
      await bgRequestPermissions();
      toast('“다른 앱 위에 표시”를 켠 뒤 VOICE FIT 으로 돌아오세요');
    };
    // 배터리 최적화 끄기/켜기: 실제 바뀌는 건 안드로이드 창에서 사용자가 고른 뒤. 돌아오면(appState) 실제 상태로 다시 그린다
    $('#bgBatteryToggle').onchange = async (e) => {
      const exempt = e.target.checked;
      e.target.checked = !exempt; // 확인 전까지는 지금 상태 유지
      await bgOpenBattery(exempt);
      toast(exempt ? '“허용”을 누르면 최적화가 꺼져요' : '배터리 → “최적화”를 고르고 돌아오세요');
      // '허용' 창은 앱을 가리지 않는 작은 창이라 돌아옴 신호가 없다 → 20초 동안 실제 상태가 바뀌는지 확인
      const before = (await bgStatus()).battery;
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        if ((await bgStatus()).battery !== before) break;
      }
      renderBgCard();
    };
  }

  if (isNative) {
  }

  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(store.getEntries(), null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `voicefit-${todayKey()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#wipeAllBtn').onclick = wipeAllData;
  $('#resetBtn').onclick = () => {
    if (!confirm('모든 운동 기록을 삭제할까요? 되돌릴 수 없어요.')) return;
    store.clearEntries();
    renderAll();
    toast('모든 기록을 삭제했어요');
  };
}

/** AI 사용 여부 = 이 기기에 사용자 키가 저장돼 있는지 */
async function refreshHealth() {
  state.ai = hasUserKey();
  const pill = $('#aiStatus');
  pill.textContent = state.ai ? 'AI 연결됨' : '오프라인 해석';
  pill.classList.toggle('ai', state.ai);
  pill.title = state.ai ? '내 OpenAI 키로 말을 해석합니다' : '키가 없어 규칙 기반으로 해석합니다 (설정에서 내 키 입력)';
  renderKeyCard();
}

function renderKeyCard() {
  const has = hasUserKey();
  $('#keyState').textContent = has ? `저장됨 (${maskKey()})` : '없음 · 오프라인 해석 사용 중';
  $('#keyDeleteBtn').hidden = !has;
  $('#keyTestBtn').hidden = !has;
}

const KEY_TEST_TEXT = { invalid: '키가 올바르지 않아요', quota: '사용 한도·잔액을 확인해 주세요', network: '인터넷 연결을 확인해 주세요' };

function initKeyCard() {
  $('#keyForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const key = $('#keyInput').value.trim();
    if (!looksLikeKey(key)) { toast('sk- 로 시작하는 OpenAI 키를 넣어 주세요'); return; }
    $('#keySaveBtn').disabled = true;
    $('#keyState').textContent = '확인 중…';
    const r = await testKey(key);
    $('#keySaveBtn').disabled = false;
    if (!r.ok && r.reason !== 'network') {
      renderKeyCard();
      toast(`저장하지 않았어요: ${KEY_TEST_TEXT[r.reason] || r.reason}`);
      return;
    }
    setUserKey(key);
    $('#keyInput').value = '';
    await refreshHealth();
    setupVoice();
    toast(r.ok ? 'AI 연결 완료! 이제 내 키로 해석해요' : '저장했어요 (인터넷 연결 후 사용돼요)');
  };
  $('#keyTestBtn').onclick = async () => {
    $('#keyState').textContent = '확인 중…';
    const r = await testKey(getUserKey());
    renderKeyCard();
    toast(r.ok ? '키가 정상이에요' : (KEY_TEST_TEXT[r.reason] || `확인 실패 (${r.reason})`));
  };
  $('#keyDeleteBtn').onclick = async () => {
    if (!confirm('이 기기에서 OpenAI 키를 지울까요? 이후에는 오프라인 해석을 써요.')) return;
    clearUserKey();
    await refreshHealth();
    setupVoice();
    toast('키를 지웠어요');
  };
}

/* ================= 잠금화면 보호 (보안) ================= */
// 잠금화면 위에 떠 있을 때는 오늘 기록·대화 내용·삭제 버튼을 숨긴다 (폰을 주운 사람이 못 보게).
// 카운터·타이머·휴식은 운동에 필요하니 그대로 보인다. 잠금이 풀리면 자동으로 다시 보인다.
let lockPoll = null;
function setLocked(locked) {
  state.locked = locked;
  document.body.classList.toggle('locked', locked);
  clearInterval(lockPoll);
  lockPoll = null;
  const p = isNative && window.Capacitor?.Plugins?.WakeService;
  if (locked && p?.lockState) {
    lockPoll = setInterval(async () => {
      const r = await p.lockState().catch(() => null);
      if (r && !r.locked) setLocked(false);
    }, 2000);
  }
}

/** 잠금 중이면 먼저 잠금 해제를 요청. 풀리면 true */
async function requireUnlock() {
  if (!state.locked) return true;
  const ok = await bgUnlock();
  if (ok) setLocked(false);
  else toast('잠금을 풀면 할 수 있어요');
  return ok;
}

/* ================= 모든 데이터 지우기 (보안·개인정보) ================= */
async function wipeAllData() {
  if (!confirm('이 기기에 저장된 VOICE FIT 데이터를 모두 지울까요?\n운동 기록, OpenAI 키, 내 목소리 등록, 호출어·설정이 모두 지워지고 되돌릴 수 없어요.')) return;
  interrupt();
  await bgStop();
  try { await state.voice?.clearVoice?.(); } catch { /* 등록 없음 */ }
  try { await window.Capacitor?.Plugins?.VoiceListener?.clearVoice?.(); } catch { /* 웹 */ }
  try { await window.Capacitor?.Plugins?.VoiceListener?.setMic?.({ key: 'auto' }); } catch { /* 웹 */ }
  clearUserKey();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('vf.') || k.startsWith('voicefit')) localStorage.removeItem(k);
  } catch { /* 저장소 접근 불가 */ }
  toast('모든 데이터를 지웠어요');
  setTimeout(() => location.reload(), 800);
}

/* ================= 마이크 장치 (PLAN 2) ================= */
let micState = null;

function renderMicCard(s) {
  const prev = micState;
  micState = s;
  const sum = micSummary(s);
  $('#micActive').textContent = sum.text;
  $('#micActive').classList.toggle('warn-text', sum.warn);
  const opts = [{ key: 'auto', name: '휴대폰 기본 마이크', kind: 'phone', sub: '자동' }, ...s.devices.filter((d) => d.kind !== 'phone')];
  // 골랐지만 지금 연결 안 된 장치도 목록에 남겨 둔다 (다시 연결되면 자동으로 그 마이크로)
  if (s.selected !== 'auto' && !opts.some((o) => o.key === s.selected)) {
    opts.push({ key: s.selected, name: s.selected.split(':').slice(1).join(':') || '고른 마이크', kind: s.selected.split(':')[0], sub: '연결 끊김' });
  }
  $('#micList').innerHTML = opts.map((o) => `
    <label class="mic-opt${o.key === s.selected ? ' on' : ''}">
      <input type="radio" name="micPick" value="${esc(o.key)}" ${o.key === s.selected ? 'checked' : ''} />
      <span>${micIcon(o.kind)} ${esc(o.name)}</span>
      ${o.sub ? `<span class="mic-sub">${esc(o.sub)}</span>` : ''}
    </label>`).join('');
  // 운동 중 이어폰이 끊기거나 다시 연결되면 알려 준다
  if (prev && s.selected !== 'auto' && prev.selected === s.selected && prev.active !== s.active) {
    toast(s.active === s.selected ? '고른 마이크로 다시 들어요' : '마이크 연결이 끊겨 휴대폰 마이크로 들어요');
  }
}

async function initMicCard() {
  if (!micPickSupported()) return; // 웹은 브라우저 기본 마이크
  $('#micCard').hidden = false;
  renderMicCard(await listMics());
  await onMicsChanged(renderMicCard);
  $('#micList').addEventListener('change', async (e) => {
    const key = e.target?.value;
    if (!key) return;
    renderMicCard(await setMic(key));
    toast(key === 'auto' ? '휴대폰 기본 마이크로 들어요' : '이 마이크로 들어요 · 내 목소리 등록도 다시 해 주세요');
  });
}

/** 처음 한 번: 무엇이 외부로 전송되는지 알린다 (PRD 7 · PLAN 2) */
function showPrivacyNoticeOnce() {
  try {
    if (localStorage.getItem('vf.privacyNotice.v2')) return;
    localStorage.setItem('vf.privacyNotice.v2', '1');
  } catch { /* 저장이 막힌 환경에서는 매번 보여 준다 */ }
  addBubble('sys', '음성 개선 v5: OpenAI 키가 있으면 앱의 일반 대화 녹음·최근 대화·직전 기록을 OpenAI로 보내 인식하고 이해해요. 자연스러운 AI 음성도 사용료가 발생하며 설정에서 끌 수 있어요. 녹음은 파일로 저장하지 않아요. (설정 → 외부로 전송되는 내용)');
}

/* ================= 시작 ================= */
async function init() {
  await initSettings();
  renderAll();
  renderCounter();
  await refreshHealth();
  setupVoice();
  initGateCard(); // 음성 엔진이 정해진 뒤에 (소리 크기를 알 수 있는지 확인)
  initVoiceCard();
  await initMicCard();
  await phone.initPhone();
  if (state.settings.listenMode && state.settings.wakeWord) await phone.keepScreenOn(true);
  resume();
  addBubble('ai', state.settings.wakeWord
    ? `“${state.settings.wakeWord}” 하고 불러 주세요. 버튼을 누르지 않아도 듣고 있어요.`
    : '설정에서 호출어를 등록하면, 앱을 열자마자 호출어를 듣고 있어요. 지금은 마이크를 눌러 말해 보세요.');
  showPrivacyNoticeOnce();
  // 백그라운드 호출로 앱이 열린 경우의 이벤트는 마지막에 연결해야 위 resume() 에 덮이지 않는다
  await bgListen({ onAppState, onWake: onBackgroundWake, onRestDone });
  await syncBackgroundService();

  if ('serviceWorker' in navigator && !isNative && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

init();
