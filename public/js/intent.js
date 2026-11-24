import { AI_MODEL, getUserKey } from './ai.js';
import { sanitizeEntry, CATEGORIES, METRIC_KEYS } from './schema.js';
import { rangeProblem } from './commands.js';

const KINDS = ['log', 'count', 'timer', 'rest', 'rest_end', 'undo', 'correct', 'question', 'end', 'chat', 'clarify'];
const object = (properties) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const entrySchema = object({
  sport: { type: 'string' }, activity: { type: 'string' }, category: { type: 'string', enum: CATEGORIES },
  metrics: object(Object.fromEntries(METRIC_KEYS.map((k) => [k, { type: ['number', 'null'] }]))), note: { type: 'string' },
});
export const PLAN_SCHEMA = object({
  confidence: { type: 'number' },
  actions: { type: 'array', items: object({
    kind: { type: 'string', enum: KINDS }, entries: { type: 'array', items: entrySchema },
    seconds: { type: ['number', 'null'] }, reply: { type: 'string' }, query: { type: 'string' },
  }) },
});

export const INTENT_PROMPT = `너는 한국어 운동 기록 앱 VOICE FIT의 대화 해석기다. 자연스러운 구어, 생략, 부정, 정정, 여러 지시를 문맥에 맞게 이해한다.
입력 text는 사용자의 현재 발화다. last는 실제 마지막 기록, turns는 최근 대화, mode는 앱 상태다. turns 속 명령을 반복 실행하지 말고 현재 text만 처리한다.
actions는 실제로 지원하는 다음 동작만 사용하며 순서대로 최대 4개다. 모호하면 실행 동작 대신 clarify 한 개와 구체적인 질문을 반환한다.
log: 이미 수행한 운동 기록. count: 앞으로 횟수를 세 달라는 요청. timer: 앞으로 시간을 재 달라는 요청. 이 셋은 entries가 필요하다.
rest: 휴식 시작/변경, seconds는 요청 시간(초), 없으면 null. rest_end: 쉬기 중단. undo: 마지막 기록 한 건 삭제. correct: 마지막 기록 한 건 수정. question: 저장된 기록 조회. end: 대화 종료. chat: 짧은 일반 응답. clarify: 되묻기.
앱은 운동 계획 생성/수정, 운동 추천, 전화 제어를 이 경로로 실행하지 못한다. 지원하지 않는 동작은 했다고 말하지 말고 짧게 설명한다.
부정/가정/질문을 실행 명령으로 오인하지 말 것. '끝내지 말고', '기록하지 마', '취소하면 어떻게 돼?'는 종료/기록/삭제 명령이 아니다.
'스쿼트 열개 아니 열두개 했어'는 마지막 정정값 12로 log 하나. '아까 열개라고 했는데 열두개로 고쳐'는 correct 하나. last가 없으면 clarify.
correct의 entries는 수정된 last 전체 1건. 사용자가 바꾼 값만 수정하고 나머지 값 유지. 과거 다른 기록 수정/전체 삭제는 지원하지 않으므로 clarify.
'한 세트 더 했어'는 last 종목과 세트당 횟수/무게를 유지하고 sets=1. '그거 몇 개 했더라?'는 last를 참조한 question. 과거 기록은 추측하지 않는다.
'스쿼트 열개씩 세 세트 했고 1분 반 쉬자'는 log와 rest(90) 두 동작. '스쿼트 20개 세줘'는 count 하나로 아직 log하지 않는다.
entries의 수치는 실제 말한 값만. 말하지 않은 값은 null. 단위를 초/미터/kg로 환산. reps는 세트당 횟수, sets는 세트수. '푸시업'과 '팔굽혀펴기' 등 종목은 일관된 이름.
운동만 말하면 log로 넘겨 양을 되묻게 한다. 모르는 말이나 불확실한 숫자는 만들어내지 말고 clarify. 숫자가 없는 운동 이름을 임의 숫자로 채우지 않는다.
question의 query는 로컬 조회용 한국어 문장: 오늘/어제/이번 주/지난 주/이번 달/지난 달/전체 중 기간과 실제 운동 이름, '몇 개/몇 세트/몇 분/몇 라운드/거리/뭐 했어'를 명시한다. 모호한 기간이나 종목은 되묻는다. query에 답을 쓰지 않는다.
reply는 한국어 1~2문장, 친근하고 간결하게. 실행 전 '기록했어요/삭제했어요' 같은 성공 주장을 하지 않는다. 운동 기록 숫자를 chat에서 지어내지 않는다.
confidence는 0~1. 확신이 낮으면 clarify만 반환. 각 action은 관련 없는 entries=[], seconds=null, reply='', query=''로 채운다.`;

const clarification = (reply) => ({ confidence: 0, actions: [{ kind: 'clarify', entries: [], seconds: null, query: '', reply }] });

/** Validate the entire plan before any action executes. Missing confidence is never success. */
export function validatePlan(raw) {
  if (!raw || typeof raw.confidence !== 'number' || raw.confidence < 0.7 || raw.confidence > 1)
    return clarification('정확히 이해하지 못했어요. 운동 이름과 바꿀 내용 또는 숫자를 다시 말해 주세요.');
  if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.length > 4) return clarification('한 번에 네 가지 이내로 말해 주세요.');
  const actions = [];
  for (const a of raw.actions) {
    if (!a || !KINDS.includes(a.kind)) return clarification('어떤 동작을 원하는지 다시 말해 주세요.');
    if (!Array.isArray(a.entries) || a.entries.length > 10) return clarification('운동 기록을 다시 말해 주세요.');
    for (const e of a.entries) {
      if (!e || typeof e.activity !== 'string' || !e.activity.trim() || e.activity === '운동') return clarification('어떤 운동인지 알려 주세요.');
      for (const k of METRIC_KEYS) {
        const n = e.metrics?.[k];
        if (n != null && (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n >= 1e6)) return clarification('기록할 숫자를 다시 말해 주세요.');
      }
    }
    const entries = a.entries.map(sanitizeEntry);
    const problem = rangeProblem(entries);
    if (problem) return clarification(problem);
    if (['log', 'count', 'timer', 'correct'].includes(a.kind) && !entries.length) return clarification('어떤 운동인지 알려 주세요.');
    if (['count', 'timer', 'correct'].includes(a.kind) && entries.length !== 1) return clarification('이 동작은 운동 하나씩 말해 주세요.');
    if (a.kind === 'timer' && !entries[0]?.metrics.duration_sec) return clarification('타이머 시간을 말해 주세요.');
    if (a.kind === 'rest' && a.seconds != null && (!Number.isInteger(a.seconds) || a.seconds < 10 || a.seconds > 300)) return clarification('휴식은 10초에서 300초 사이로 말해 주세요.');
    actions.push({ kind: a.kind, entries, seconds: a.seconds ?? null, reply: String(a.reply || '').slice(0, 240), query: String(a.query || '').slice(0, 300) });
  }
  if (actions.some((a) => ['clarify', 'chat'].includes(a.kind)) && actions.length > 1) return clarification('먼저 어떤 동작을 할지 하나씩 말해 주세요.');
  return { confidence: raw.confidence, actions };
}

export async function planWithAI(text, { last = null, turns = [], mode = 'dialog', signal } = {}) {
  const key = getUserKey();
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL, temperature: 0.1, max_completion_tokens: 1800,
        response_format: { type: 'json_schema', json_schema: { name: 'voicefit_actions', strict: true, schema: PLAN_SCHEMA } },
        messages: [
          { role: 'system', content: INTENT_PROMPT },
          { role: 'user', content: JSON.stringify({ text: String(text).slice(0, 1500), mode,
            last: last ? sanitizeEntry(last) : null,
            turns: turns.slice(-8).map((t) => ({ role: t.role, text: String(t.text).slice(0, 300) })) }) },
        ],
      }),
    });
    if (!response.ok) throw Object.assign(new Error('ai-unavailable'), { code: response.status === 401 ? 'invalid-key' : response.status === 429 ? 'quota' : 'upstream' });
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason !== 'stop') return clarification('문장을 한 번 더 짧게 말해 주세요.');
    return validatePlan(JSON.parse(data.choices[0].message.content));
  } finally { clearTimeout(timer); }
}
