// 서버·클라이언트가 공유하는 기록 형식 정리 함수 (AI 응답을 그대로 믿지 않고 형태를 맞춘다).
export const CATEGORIES = ['맨몸', '웨이트', '유산소', '구기', '격투기', '기타'];
export const METRIC_KEYS = ['reps', 'sets', 'weight_kg', 'duration_sec', 'distance_m', 'rounds'];
const INTENTS = ['log', 'undo', 'unknown'];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1e6 ? Math.round(n * 100) / 100 : null;
}

export function sanitizeEntry(e = {}) {
  return {
    sport: str(e.sport, 30) || '기타',
    activity: str(e.activity, 40) || '운동',
    category: CATEGORIES.includes(e.category) ? e.category : '기타',
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, num(e.metrics?.[k])])),
    note: str(e.note, 100),
  };
}

export function sanitizeParse(o = {}) {
  const intent = INTENTS.includes(o.intent) ? o.intent : 'unknown';
  const entries = intent === 'log'
    ? (Array.isArray(o.entries) ? o.entries : []).slice(0, 10).map(sanitizeEntry)
    : [];
  // 확신도(0~1): 말뜻을 얼마나 확실히 알아들었는지. 없으면 1 (PLAN 6 — 0.7 미만이면 실행하지 않고 되묻는다)
  const c = Number(o.confidence);
  const confidence = o.confidence !== undefined && o.confidence !== null && Number.isFinite(c)
    ? Math.min(1, Math.max(0, c > 1 ? c / 100 : c))
    : 1;
  return { intent: intent === 'log' && !entries.length ? 'unknown' : intent, entries, reply: str(o.reply, 120), confidence };
}
