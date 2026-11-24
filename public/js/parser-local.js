// 오프라인 규칙 기반 해석기: AI 서버에 연결할 수 없을 때 쓰는 대체 경로.
// AI 해석기(js/ai.js)와 같은 결과 형식 { intent, entries, reply } 를 돌려준다.
import { sanitizeParse } from './schema.js';

const CATEGORY_RULES = [
  ['격투기', /(복싱|권투|킥복싱|주짓수|유도|태권도|무에타이|스파링|미트|샌드백|레슬링|mma|격투|쉐도우)/i],
  ['구기', /(축구|농구|배구|야구|테니스|배드민턴|탁구|골프|풋살|슈팅|드리블|패스|리프팅|슛|스윙|서브)/],
  ['유산소', /(러닝|런닝|달리기|뛰었|뛰기|조깅|걷기|걸었|산책|자전거|사이클|수영|등산|줄넘기|로잉|트레드밀|인터벌)/],
  ['웨이트', /(벤치|데드|바벨|덤벨|프레스|컬|로우|랫풀|레그\s*익스텐션|케틀벨|머신|킬로|kg)/i],
  ['맨몸', /(스쿼트|푸시업|푸쉬업|팔굽혀|윗몸|런지|플랭크|버피|턱걸이|풀업|딥스|크런치|싯업|마운틴|점핑잭)/],
];
const SPORT_WORDS = /(축구|농구|배구|야구|테니스|배드민턴|탁구|골프|풋살|복싱|킥복싱|주짓수|유도|태권도|무에타이|레슬링|수영|등산|러닝|자전거|요가|필라테스|클라이밍)/;
const DEFAULT_SPORT = { 맨몸: '맨몸운동', 웨이트: '헬스', 유산소: '유산소', 구기: '구기', 격투기: '격투기', 기타: '기타' };
const DISTANCE_SPORTS = /(러닝|런닝|달리기|뛰|조깅|걷|산책|자전거|사이클|수영|등산|트레드밀)/;

const KOR_NUM = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 스무: 20, 스물: 20, 서른: 30 };

/** "세 세트", "다섯 라운드", "두 번" 같은 한글 수사를 숫자로 바꾼다. */
export function normalizeNumbers(text) {
  return text.replace(
    /(하나|한|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른)\s*(세트|라운드|판|번|회|개|분|시간|바퀴)/g,
    (_, k, unit) => `${KOR_NUM[k]}${unit}`,
  );
}

function categorize(text) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return '기타';
}

function pickNum(text, re) {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

function parseOne(segment) {
  const t = segment.trim();
  if (!t) return null;
  const category = categorize(t);
  const isDistance = DISTANCE_SPORTS.test(t);

  const hours = pickNum(t, /(\d+(?:\.\d+)?)\s*시간/);
  const mins = pickNum(t, /(\d+(?:\.\d+)?)\s*분(?!\s*당)/);
  const secs = pickNum(t, /(\d+)\s*초/);
  const duration = (hours || 0) * 3600 + (mins || 0) * 60 + (secs || 0);

  let km = pickNum(t, /(\d+(?:\.\d+)?)\s*(?:km|키로미터|킬로미터)/i);
  let kg = pickNum(t, /(\d+(?:\.\d+)?)\s*(?:kg|키로그램|킬로그램)/i);
  const kilo = pickNum(t, /(\d+(?:\.\d+)?)\s*(?:킬로|키로)(?!미터|그램)/);
  if (kilo !== null) { if (isDistance) km ??= kilo; else kg ??= kilo; }
  const meters = pickNum(t, /(\d+)\s*(?:m|미터)(?![a-z])/i);

  const metrics = {
    reps: pickNum(t, /(\d+)\s*(?:개|회|번|reps?)/i),
    sets: pickNum(t, /(\d+)\s*세트/),
    weight_kg: kg,
    duration_sec: duration || null,
    distance_m: km !== null ? km * 1000 : meters,
    rounds: pickNum(t, /(\d+)\s*(?:라운드|판|바퀴)/),
  };

  // 운동 이름 = 첫 숫자 앞부분에서 조사·동사 정리
  const head = t.split(/\d/)[0]
    .replace(/(오늘|방금|아까|지금)\s*/g, '')
    .replace(/\s*(할게요?|할래|할거야|할 거야|해볼게|하기|시작|했어요?|했고|했음|하고|하자)\s*$/, '')
    .trim();
  // 조사 떼기. 단, 운동 이름 자체가 조사처럼 끝나면(요가, 필라테스로…) 떼지 않는다: "요가" → "요" 방지
  const noParticle = head.replace(/\s*(을|를|은|는|이|가|으로|로)\s*$/, '').trim();
  const knownWord = (s) => SPORT_WORDS.test(s) || CATEGORY_RULES.some(([, re]) => re.test(s));
  let activity = noParticle !== head && knownWord(head) && !knownWord(noParticle) ? head : noParticle;
  if (!activity) activity = t.replace(/\d.*$/, '').trim();
  const sportMatch = t.match(SPORT_WORDS);
  const sport = sportMatch ? sportMatch[1] : DEFAULT_SPORT[category];
  if (!activity) activity = category === '기타' ? '운동' : sport;

  const hasMetric = Object.values(metrics).some((v) => v !== null);
  if (!hasMetric && category === '기타') return null;
  return { sport, activity, category, metrics, note: '' };
}

/**
 * @param {string} text 사용자의 말(또는 입력)
 * @param {object|null} last 직전 기록 (한 세트 더 처리용)
 */
export function parseLocal(text, last = null) {
  const t = normalizeNumbers(String(text || '').trim());
  if (!t) return sanitizeParse({ intent: 'unknown' });

  if (/(취소|지워|삭제|잘못\s*(말|기록))/.test(t)) {
    return sanitizeParse({ intent: 'undo', reply: '방금 기록을 지웠어요.' });
  }

  const repeat = t.match(/(\d+)?\s*세트\s*더|한\s*번\s*더|똑같이|같은\s*거|아까\s*(그거|거|그)/);
  if (repeat && last) {
    const sets = Number(repeat[1]) || 1;
    const entry = { ...last, metrics: { ...last.metrics, sets } };
    return sanitizeParse({ intent: 'log', entries: [entry], reply: `${last.activity} ${sets}세트 더, 기록했어요!` });
  }

  const entries = t.split(/,|그리고|그다음|그 다음/).map(parseOne).filter(Boolean);
  if (!entries.length) return sanitizeParse({ intent: 'unknown' });
  return sanitizeParse({ intent: 'log', entries, confidence: localConfidence(entries) });
}

/**
 * 규칙 해석의 확신도 (PLAN 6).
 * - 아는 운동 종류(맨몸·웨이트·유산소·구기·격투기)면 높게
 * - 분류는 모르지만 이름과 숫자가 분명하면 보통
 * - 이름을 못 찾고 숫자만 있으면(예: "20개") 낮게 → 되묻기
 */
export function localConfidence(entries) {
  let min = 1;
  for (const e of entries) {
    let c = 0.9;
    if (e.category === '기타') c = e.activity && e.activity !== '운동' && e.activity.length >= 2 ? 0.75 : 0.5;
    min = Math.min(min, c);
  }
  return min;
}
