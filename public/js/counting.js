// 카운트 모드: 사용자가 "하나, 둘, 셋…" 또는 "1, 2, 3…" 하고 세는 소리에서 현재 개수를 읽어낸다.
const NATIVE_TENS = [['아흔', 90], ['여든', 80], ['일흔', 70], ['예순', 60], ['쉰', 50], ['마흔', 40], ['서른', 30], ['스물', 20], ['스무', 20], ['열', 10]];
const NATIVE_ONES = [['하나', 1], ['한', 1], ['둘', 2], ['두', 2], ['셋', 3], ['세', 3], ['석', 3], ['넷', 4], ['네', 4], ['다섯', 5], ['여섯', 6], ['일곱', 7], ['여덟', 8], ['여덜', 8], ['아홉', 9]];
const SINO = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };

/** 붙어 있는 한글 수사 덩어리("열하나", "스물셋", "이십삼")를 숫자로 */
function readKoreanNumber(word) {
  // 고유어: (십의자리)? (일의자리)?
  for (const [tw, tv] of [...NATIVE_TENS, ['', 0]]) {
    if (!word.startsWith(tw)) continue;
    const rest = word.slice(tw.length);
    if (!rest && tv) return tv;
    const one = NATIVE_ONES.find(([o]) => o === rest);
    if (one) return tv + one[1];
  }
  // 한자어: (일~구)?십(일~구)? 또는 한 글자
  const m = word.match(/^([일이삼사오육칠팔구])?십([일이삼사오육륙칠팔구])?$/);
  if (m) return (m[1] ? SINO[m[1]] : 1) * 10 + (m[2] ? SINO[m[2]] : 0);
  if (word.length === 1 && SINO[word]) return SINO[word];
  return null;
}

// 한 개의 수만 잡는다: "하나둘셋" → 하나 / 둘 / 셋, "열하나" → 열하나. "세트"의 '세'는 제외.
const TENS = NATIVE_TENS.map(([w]) => w).join('|');
const ONES = NATIVE_ONES.map(([w]) => w).join('|');
const KOREAN_TOKEN = new RegExp(
  `(?:${TENS})(?:${ONES})?(?!트)|(?:${ONES})(?!트)|[일이삼사오육륙칠팔구]?십[일이삼사오육륙칠팔구]?|[일이삼사오육칠팔구]`,
  'g',
);

/** 문장 안의 모든 카운트 숫자를 순서대로 뽑는다. */
export function extractCounts(text) {
  const out = [];
  const t = String(text || '');
  const re = new RegExp(`\\d+|${KOREAN_TOKEN.source}`, 'g');
  for (const m of t.matchAll(re)) {
    const v = /^\d+$/.test(m[0]) ? Number(m[0]) : readKoreanNumber(m[0]);
    if (v && v <= 300) out.push(v);
  }
  return out;
}

const MAX_JUMP = 5;

/**
 * 센 소리를 반영해 개수를 앞으로 옮긴다.
 * - 몇 개를 놓쳐도 마지막으로 들린 숫자로 따라간다 (5개 이내).
 * - 5개보다 크게 앞선 숫자는 한 번만 들리면 오인식일 수 있어 보류하지만,
 *   바로 다음 숫자가 이어서 들리면(예: 14 → 15) 사용자가 실제로 거기까지 센 것이므로 즉시 따라간다.
 *   (앱이 뒤처졌을 때 영영 못 따라잡던 문제 해결)
 * @param {{count:number, lastHeard:number|null}} from
 * @returns {{count:number, lastHeard:number|null}}
 */
export function advanceCount(from, text) {
  let { count, lastHeard } = from;
  const vals = extractCounts(text);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v > count) {
      const close = v - count <= MAX_JUMP;
      const followsLast = lastHeard !== null && v === lastHeard + 1;
      const followedByNext = vals[i + 1] === v + 1;
      if (close || followsLast || followedByNext) count = v;
    }
    lastHeard = v;
  }
  return { count, lastHeard };
}

/** 지금까지 센 개수 (이전 호환용: 직전에 들린 숫자 정보 없이) */
export function currentCount(prev, text) {
  return advanceCount({ count: prev, lastHeard: null }, text).count;
}

export const SET_END_RE = /(세트\s*끝|끝|그만|스톱|stop|다\s*했|완료)/i;
export const WORKOUT_END_RE = /(운동\s*끝|운동\s*종료|카운트\s*종료|종료|이제\s*그만|오늘\s*끝)/;
// 카운트를 요청하는 말: "카운트 시작할께", "세어 줘", "같이 세자", "세면서 할게", "스쿼트 20개 시작할게" 등
export const COUNT_REQUEST_RE = /(카운트|카운팅|세어|세줘|세 줘|셀게|셀께|세면서|세볼게|세 볼게|같이\s*세|숫자\s*세|시작\s*(할게|할께|하자|한다|해\s*줘|해줘|합니다|할게요)|시작$)/;

// 타이머 요청: "플랭크 1분 타이머", "30초 버틸게", "시간 재 줘"
export const TIMER_RE = /(타이머|스톱워치|버티기|버틸게|버틸께|버텨|시간\s*재|재\s*줘|재줘)/;
// 타이머 시작 신호 / 진행 중 멈춤 / 대기 중 취소
export const START_SIGNAL_RE = /(시작|스타트|고고|출발|레디|지금|go)/i;
export const TIMER_STOP_RE = /(그만|정지|중지|스톱|stop|멈춰|끝)/i;
export const TIMER_CANCEL_RE = /(취소|안\s*할래|안\s*해|그만|나중에)/;

/** 타이머 세트들을 기록 항목으로. 시간이 모두 같으면 한 항목(세트 수), 다르면 세트별 */
export function timerToEntries(base, durations) {
  const done = durations.filter((d) => d > 0);
  if (!done.length) return [];
  const entry = (sec, sets, note) => ({ ...base, metrics: { ...(base.metrics || {}), reps: null, duration_sec: sec, sets }, note });
  if (done.every((d) => d === done[0])) return [entry(done[0], done.length, '타이머')];
  return done.map((d, i) => entry(d, 1, `타이머 ${i + 1}세트`));
}

/** 카운트 요청 말을 지워서 운동 이름·목표만 남긴다 */
export const stripCountWords = (t) => String(t || '')
  .replace(/(카운트|카운팅)\s*(모드)?\s*(시작)?\s*(할게요|할게|할께|하자|한다|해\s*줘|해줘|합니다)?/g, ' ')
  .replace(/(같이\s*)?(세어\s*줘|세줘|세 줘|셀게|셀께|세볼게|세 볼게|세자|숫자\s*세(어|줘)?)/g, ' ')
  .replace(/세면서\s*(할게|할께|할래|하자|해)?/g, ' ')
  .replace(/시작\s*(할게요|할게|할께|하자|한다|해\s*줘|해줘|합니다)?/g, ' ')
  .replace(/(타이머|스톱워치)\s*(맞춰\s*줘|맞춰줘|설정|켜\s*줘|켜줘)?|버티기|버틸게|버틸께|버텨|시간\s*재\s*(줘)?|재\s*줘|재줘/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** 여러 세트를 기록 항목으로 묶는다. 세트마다 개수가 같으면 한 항목, 다르면 세트별 항목. */
export function setsToEntries(base, sets) {
  const done = sets.filter((n) => n > 0);
  if (!done.length) return [];
  const same = done.every((n) => n === done[0]);
  const entry = (reps, setCount, note) => ({
    ...base,
    metrics: { ...(base.metrics || {}), reps, sets: setCount },
    note,
  });
  if (same) return [entry(done[0], done.length, '카운트 모드')];
  return done.map((n, i) => entry(n, 1, `카운트 모드 ${i + 1}세트`));
}
