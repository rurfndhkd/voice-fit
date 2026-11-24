// 말로 하는 명령 중 '기록'이 아닌 것들 — 휴식 타이머(PLAN 12)와 값 범위 확인(PLAN 9), 확신도 기준(PLAN 6).
// 화면·음성 엔진과 분리해 테스트할 수 있게 한다.

/* ---------- PLAN 6: 확신도 ---------- */
export const MIN_CONFIDENCE = 0.7; // 이보다 낮으면 실행하지 않고 "다시 말씀해 주세요"
// Fast local controls must wait for a complete utterance and respect common negations.
export const isNegatedControl = (text) => /(지\s*마|지\s*말|하지\s*않|아직\s*(끝|종료|시작|그만)|안\s*(끝|멈|쉴|쉬))/i.test(String(text || ''));

/* ---------- PLAN 9: 값 범위 ---------- */
export const LIMITS = {
  reps: [1, 1000, '횟수는 1에서 1000 사이로 말해 주세요.'],
  sets: [1, 1000, '세트는 1에서 1000 사이로 말해 주세요.'],
  rounds: [1, 1000, '라운드는 1에서 1000 사이로 말해 주세요.'],
  duration_sec: [1, 24 * 3600, '시간은 24시간 이내로 말해 주세요.'],
};

/** 기록하려는 값 중 허용 범위를 벗어난 것이 있으면 안내 문장, 없으면 null */
export function rangeProblem(entries) {
  for (const e of entries || []) {
    for (const [key, [min, max, msg]] of Object.entries(LIMITS)) {
      const v = e?.metrics?.[key];
      if (v === null || v === undefined) continue;
      if (v < min || v > max || (key !== 'duration_sec' && !Number.isInteger(v))) {
        return `${e.activity ? `${e.activity} ` : ''}${fmtValue(key, v)}는 기록할 수 없어요. ${msg}`;
      }
    }
  }
  return null;
}

function fmtValue(key, v) {
  if (key === 'reps') return `${v}개`;
  if (key === 'sets') return `${v}세트`;
  if (key === 'rounds') return `${v}라운드`;
  return `${Math.round(v / 60)}분`;
}

/* ---------- PLAN 12: 휴식 타이머 ---------- */
export const REST_MIN = 10;
export const REST_MAX = 300;

const REST_WORD = /(휴식|쉬[자고어었는기]|쉴게|쉴래|쉴까|레스트|브레이크)/;
export const REST_END_RE = /(휴식\s*(끝|종료|그만|중지|멈춰)|그만\s*쉴|다\s*쉬었|쉬는\s*거\s*(끝|그만)|휴식\s*취소)/;
const SINO = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const NATIVE = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50 };

/** "구십" → 90, "삼십" → 30, "백이십" → 120 */
function sinoNumber(w) {
  const m = w.match(/^(?:([이삼사오육칠팔구])?백)?(?:([이삼사오육칠팔구])?십)?([일이삼사오육칠팔구])?$/);
  if (!m || !w) return null;
  const hasHundred = w.includes('백');
  const hasTen = w.includes('십');
  return (hasHundred ? (m[1] ? SINO[m[1]] : 1) * 100 : 0) + (hasTen ? (m[2] ? SINO[m[2]] : 1) * 10 : 0) + (m[3] ? SINO[m[3]] : 0);
}

function toNumber(w) {
  if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
  if (NATIVE[w] !== undefined) return NATIVE[w];
  const s = sinoNumber(w);
  return s || null;
}

const NUM = '(\\d+(?:\\.\\d+)?|[일이삼사오육칠팔구백십]+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|쉰)';

/** 문장 속 시간(초). "1분 30초" → 90, "90초" → 90, "2분" → 120, "반" ("1분 반") → +30 */
export function parseSeconds(text) {
  const t = String(text || '');
  let total = 0;
  let found = false;
  const min = t.match(new RegExp(`${NUM}\\s*분(\\s*반)?`));
  if (min) { const v = toNumber(min[1]); if (v !== null) { total += v * 60 + (min[2] ? 30 : 0); found = true; } }
  const sec = t.match(new RegExp(`${NUM}\\s*초`));
  if (sec) { const v = toNumber(sec[1]); if (v !== null) { total += v; found = true; } }
  return found ? Math.round(total) : null;
}

/**
 * 휴식 명령 해석.
 * @returns {null | { action: 'end' } | { action: 'start', seconds: number|null, problem: string|null }}
 *   seconds=null: 시간을 말하지 않음(되묻기), problem: 범위 밖 안내
 */
export function parseRest(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (isNegatedControl(t)) return null;
  if (REST_END_RE.test(t)) return { action: 'end' };
  if (!REST_WORD.test(t)) return null;
  // "휴식 끝"이 아닌데 '쉬'가 들어간 다른 말(예: "쉬운 운동")은 제외: 휴식어 뒤/앞에 시간이 있거나, 휴식어로 시작·끝나는 짧은 말만
  const seconds = parseSeconds(t);
  const short = t.replace(/\s+/g, '').length <= 12;
  if (seconds === null && !short) return null;
  if (seconds === null) return { action: 'start', seconds: null, problem: null };
  if (seconds < REST_MIN || seconds > REST_MAX) {
    return { action: 'start', seconds, problem: `휴식은 ${REST_MIN}초에서 ${REST_MAX}초(5분) 사이로 말해 주세요.` };
  }
  return { action: 'start', seconds, problem: null };
}

export const restLabel = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}분${sec % 60 ? ` ${sec % 60}초` : ''}` : `${sec}초`);

/** "2분" → "2분으로", "30초" → "30초로" (받침에 맞는 조사) */
export function withRo(word) {
  const w = String(word || '');
  const c = w.charCodeAt(w.length - 1) - 0xac00;
  const jong = c >= 0 && c <= 11171 ? c % 28 : 0;
  return `${w}${jong && jong !== 8 ? '으로' : '로'}`; // ㄹ 받침은 '로'
}
