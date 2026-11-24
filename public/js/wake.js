// 호출어(웨이크 워드) 판별.
// 음성인식은 띄어쓰기·받침·비슷한 소리를 자주 틀리므로 한글을 자모(ㅂ ㅗ ㅇ ㅣ…) 단위로 쪼개서
// 비슷한 정도(편집 거리)로 비교한다. 인식 후보 여러 개 중 하나만 맞아도 호출로 본다.
export const normalizeWake = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 소리가 비슷해 자주 헷갈리는 자모는 같은 것으로 본다 (ㅐ/ㅔ, ㅒ/ㅖ, 된소리·거센소리/예사소리)
const SIMILAR = { 'ㅔ': 'ㅐ', 'ㅖ': 'ㅒ', 'ㄲ': 'ㄱ', 'ㄸ': 'ㄷ', 'ㅃ': 'ㅂ', 'ㅆ': 'ㅅ', 'ㅉ': 'ㅈ', 'ㅋ': 'ㄱ', 'ㅌ': 'ㄷ', 'ㅍ': 'ㅂ', 'ㅊ': 'ㅈ' };
const sim = (j) => SIMILAR[j] || j;

/** 문자열 → [{ j: 자모, i: 원문 글자 위치 }] (글자·숫자만) */
function toJamo(text) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const n = code - 0xac00;
      out.push({ j: sim(CHO[Math.floor(n / 588)]), i });
      out.push({ j: sim(JUNG[Math.floor((n % 588) / 28)]), i });
      const jong = JONG[n % 28];
      if (jong) out.push({ j: sim(jong), i });
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      out.push({ j: ch.toLowerCase(), i });
    }
  }
  return out;
}

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 허용 오차: 자모 길이의 약 30% (아주 짧은 호출어는 정확히 맞아야 함) */
export const tolerance = (len) => (len <= 4 ? 0 : Math.max(1, Math.round(len * 0.3)));

/**
 * @returns {{ matched: boolean, rest: string, score: number }}
 *   rest = 호출어 뒤에 이어서 말한 내용 ("보이스핏 스쿼트 15개" → "스쿼트 15개")
 */
export function matchWake(transcript, wakeWord) {
  const t = toJamo(transcript);
  const w = toJamo(wakeWord).map((x) => x.j);
  if (!t.length || w.length < 2) return { matched: false, rest: '', score: Infinity };
  const tj = t.map((x) => x.j);
  const tol = tolerance(w.length);

  // 글자(음절) 경계에서만 시작·끝나도록 비교한다 → 뒤에 이어진 말이 잘리지 않음
  const starts = [];
  const ends = [];
  for (let k = 0; k < t.length; k++) {
    if (k === 0 || t[k].i !== t[k - 1].i) starts.push(k);
    if (k === t.length - 1 || t[k].i !== t[k + 1].i) ends.push(k);
  }
  let best = { d: Infinity, end: -1 };
  for (const s of starts) {
    for (const e of ends) {
      const len = e - s + 1;
      if (len < w.length - tol || len > w.length + tol) continue;
      const d = distance(tj.slice(s, e + 1), w);
      // 같은 거리면 더 앞쪽에서 끝나는 것을 쓴다
      if (d < best.d || (d === best.d && e < best.end)) best = { d, end: e };
    }
  }
  if (best.d > tol) return { matched: false, rest: '', score: best.d };

  // 호출어가 끝난 글자 다음부터가 나머지 말 (한 글자만 남으면 인식 찌꺼기로 보고 버림)
  const lastChar = t[best.end].i;
  let rest = String(transcript).slice(lastChar + 1).replace(/^[\s,.!?~]+/, '').trim();
  if (normalizeWake(rest).length <= 1) rest = '';
  return { matched: true, rest, score: best.d };
}

/** 여러 인식 후보 중 가장 잘 맞는 것 */
export function matchWakeAny(candidates, wakeWord) {
  let best = { matched: false, rest: '', score: Infinity };
  for (const c of candidates || []) {
    if (!c) continue;
    const m = matchWake(c, wakeWord);
    if (m.matched && m.score < best.score) best = m;
    if (best.score === 0) break;
  }
  return best;
}

/** 등록할 수 있는 호출어인지 */
export function validateWake(word) {
  const n = normalizeWake(word);
  if (n.length < 2) return '호출어가 너무 짧아요. 두 글자 이상으로 말해 주세요.';
  if (n.length > 12) return '호출어가 너무 길어요. 짧게 말해 주세요.';
  return null;
}
