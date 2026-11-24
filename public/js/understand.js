// 잘못 들린 말 알아듣기 — 음성 비서처럼 "대충 맞게 들린 말"을 문맥으로 바로잡는다.
//  1) 자주 틀리게 들리는 말 고치기 (스커트→스쿼트, 카운터→카운트 …)
//  2) 운동 이름과 발음이 아주 비슷한 단어를 그 운동으로 바로잡기 (자모 단위 비교)
//     — 운동 얘기를 하는 문장(숫자·세트·카운트·타이머 등)일 때만. "커피 마시고 올게"는 건드리지 않는다
//  3) 음성 인식 후보(최대 5개) 중 운동·명령으로 가장 말이 되는 문장 고르기
//  4) 사용자가 전에 기록한 운동 이름을 어휘에 더해 우선 알아듣기
// 원래 1순위 문장에 이미 운동 이름이 있거나 끝내는 말이면 그대로 둔다(맞는 말을 틀리게 고치지 않기 위해).

export const EXERCISES = [
  '스쿼트', '푸시업', '팔굽혀펴기', '런지', '플랭크', '버피', '턱걸이', '풀업', '친업', '딥스', '크런치', '싯업',
  '윗몸일으키기', '레그레이즈', '마운틴클라이머', '점핑잭', '벤치프레스', '데드리프트', '숄더프레스',
  '오버헤드프레스', '바벨로우', '덤벨로우', '덤벨컬', '바벨컬', '해머컬', '레그프레스', '레그컬',
  '레그익스텐션', '랫풀다운', '케이블로우', '사이드레터럴레이즈', '카프레이즈', '힙쓰러스트', '브릿지',
  '케틀벨스윙', '박스점프', '줄넘기', '러닝', '사이클', '로잉', '스트레칭',
];

// 자주 틀리게 들리는 말 (앞: 들린 말, 뒤: 뜻한 말). 띄어 쓴 경우도 잡는다
const KNOWN = [
  [/스\s*커\s*트/g, '스쿼트'], [/스\s*쿼\s*드/g, '스쿼트'], [/스\s*퀏\s*트?/g, '스쿼트'], [/수\s*쿼\s*트/g, '스쿼트'],
  [/푸\s*쉬\s*업/g, '푸시업'], [/프\s*시\s*업/g, '푸시업'], [/push\s*-?\s*up/gi, '푸시업'],
  [/플\s*랭\s*그/g, '플랭크'], [/플\s*랑\s*크/g, '플랭크'], [/플\s*랜\s*크/g, '플랭크'],
  [/벤\s*치\s*프\s*[래레]\s*스/g, '벤치프레스'], [/데\s*드\s*리\s*프\s*트/g, '데드리프트'],
  [/랫\s*풀\s*다\s*운/g, '랫풀다운'], [/버\s*피\s*테\s*스\s*트/g, '버피'],
  [/카운터(?=\s*(시작|세|해|할|모드|켜|부탁|좀|$))/g, '카운트'], [/카\s*운\s*트/g, '카운트'],
  [/타\s*이\s*마/g, '타이머'], [/타\s*이\s*머/g, '타이머'],
];

// 운동 이름 목록에 없어도 이미 뜻이 분명한 활동 (이런 말이 1순위에 있으면 다른 후보로 바꾸지 않는다)
const OTHER_ACTIVITY = /(수영|러닝|런닝|달리기|뛰|조깅|걷기|걸었|산책|자전거|등산|요가|필라테스|축구|농구|배구|야구|테니스|배드민턴|탁구|골프|풋살|복싱|권투|주짓수|유도|태권도|클라이밍|헬스|웨이트|벤치|덤벨|바벨|케틀벨)/;
// 운동 얘기를 하는 문장인지 (이럴 때만 발음 유사도로 운동 이름을 고친다)
const WORKOUT_CUE = /(\d|세트|개|회|번|분|초|카운트|타이머|시작|기록|할게|하자|셀게|세자|세줘|세어|했어|라운드|kg|킬로)/i;
// 끝내기·취소 같은 말은 후보 고르기로 바꾸지 않는다
const KEEP_TOP = /(그만|끝|종료|취소|지워|삭제|고마워|됐어|넘어가|패스|스킵|몰라)/;
// 고치면 안 되는 흔한 낱말
const STOP_WORDS = new Set(['시작', '카운트', '타이머', '세트', '오늘', '방금', '아까', '지금', '그리고', '다음', '휴식', '기록', '운동',
  '하나', '다섯', '여섯', '일곱', '여덟', '아홉', '스물', '서른', '마흔', '그만', '정도', '같이', '천천히', '빨리']);
const PARTICLE = /(으로|에서|까지|부터|이랑|하고|을|를|은|는|이|가|도|만|로|랑|와|과)$/;

/* ---------- 한글 자모 ---------- */
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** "스쿼트" → ['ㅅ','ㅡ','ㅋ','ㅝ','ㅌ','ㅡ'] */
export function toJamo(s) {
  const out = [];
  for (const ch of String(s || '')) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) { out.push(ch); continue; }
    out.push(CHO[Math.floor(c / 588)], JUNG[Math.floor((c % 588) / 28)]);
    if (c % 28) out.push(JONG[c % 28]);
  }
  return out;
}

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const isHangulWord = (w) => /^[가-힣]+$/.test(w);
// 자모 길이에 따라 허용하는 차이: 짧은 말일수록 엄격하게
const allowed = (len) => (len <= 6 ? 1 : len <= 10 ? 2 : 3);

/** 어휘 중 발음이 가장 가까운 운동 이름 (충분히 가까울 때만) */
export function nearestExercise(word, vocab = EXERCISES) {
  if (!isHangulWord(word) || word.length < 2 || STOP_WORDS.has(word)) return null;
  if (vocab.includes(word)) return word;
  const wj = toJamo(word);
  let best = null;
  let bestD = Infinity;
  for (const v of vocab) {
    if (Math.abs(v.length - word.length) > 1) continue;
    const d = distance(wj, toJamo(v));
    if (d < bestD) { bestD = d; best = v; }
  }
  if (!best) return null;
  return bestD <= allowed(Math.max(wj.length, toJamo(best).length)) ? best : null;
}

/** 문장에 들어 있는 운동 이름 개수 */
function exerciseHits(text, vocab) {
  const compact = text.replace(/\s+/g, '');
  return vocab.filter((v) => compact.includes(v)).length;
}

/**
 * 한 문장 바로잡기.
 * @returns {{ text: string, fixes: number }}
 */
export function correctText(raw, vocab = EXERCISES) {
  let text = String(raw || '').trim();
  let fixes = 0;
  for (const [re, to] of KNOWN) {
    text = text.replace(re, (m) => { if (m.replace(/\s+/g, '') !== to) fixes++; return to; });
  }
  if (!WORKOUT_CUE.test(text)) return { text, fixes };

  const tokens = text.split(/\s+/);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // "스쿼드20개" → 앞의 한글 부분만 비교
    const head = tok.match(/^[가-힣]+/)?.[0] || '';
    const tail = tok.slice(head.length);
    const core = head.replace(PARTICLE, '');
    const particle = head.slice(core.length);
    // 띄어 쓴 두 조각이 한 운동 이름일 수 있다 ("벤치 프래스")
    const nextHead = tokens[i + 1]?.match(/^[가-힣]+/)?.[0] || '';
    if (core && nextHead && !tail) {
      const nextCore = nextHead.replace(PARTICLE, '');
      const joined = nearestExercise(core + nextCore, vocab);
      if (joined && !vocab.includes(core) && (core + nextCore).length >= 3) {
        const nextTok = tokens[i + 1];
        out.push(joined + nextHead.slice(nextCore.length) + nextTok.slice(nextHead.length));
        if (joined !== core + nextCore) fixes++;
        i++;
        continue;
      }
    }
    const fixed = core ? nearestExercise(core, vocab) : null;
    if (fixed && fixed !== core) { out.push(fixed + particle + tail); fixes++; } else out.push(tok);
  }
  return { text: out.join(' '), fixes };
}

/**
 * 인식 후보들 중 가장 말이 되는 문장을 골라 바로잡아 돌려준다.
 * @param {string} top 1순위 인식 결과
 * @param {string[]} candidates 다른 후보들 (1순위 포함 가능)
 * @param {{ history?: string[], activity?: string }} ctx 지난 기록의 운동 이름들, 지금 하는 운동
 * @returns {{ text: string, changed: boolean }}
 */
export function understand(top, candidates = [], ctx = {}) {
  const raw = String(top || '').trim();
  if (!raw) return { text: '', changed: false };
  const vocab = [...new Set([...(ctx.history || []).filter((w) => isHangulWord(w) && w.length >= 2), ...EXERCISES])];
  const first = correctText(raw, vocab);
  if (KEEP_TOP.test(raw) || OTHER_ACTIVITY.test(first.text) || exerciseHits(first.text, vocab) > 0) {
    return { text: first.text, changed: first.text !== raw };
  }

  // 1순위에 운동 이름이 없을 때만 다른 후보를 본다
  let best = { ...first, score: -Infinity };
  const list = [raw, ...candidates.map((c) => String(c || '').trim()).filter((c) => c && c !== raw)];
  list.forEach((cand, rank) => {
    const r = correctText(cand, vocab);
    const hits = exerciseHits(r.text, vocab);
    const cue = WORKOUT_CUE.test(r.text) ? 1 : 0;
    const same = ctx.activity && r.text.replace(/\s+/g, '').includes(ctx.activity) ? 1 : 0;
    const score = hits * 3 + cue + same - r.fixes * 0.5 - rank * 0.3;
    if (score > best.score) best = { ...r, score };
  });
  return { text: best.text, changed: best.text !== raw };
}
