// PLAN 15 · 음성으로 기록을 물으면 "저장된 기록만" 보고 답한다 (AI 가 지어낸 숫자를 말하지 않도록 기기 안에서 계산).
// 예: "오늘 스쿼트 몇 개 했어?", "어제 뭐 했어?", "이번 주 푸시업 몇 세트야?", "지난번 런지 기록 알려줘"
import { nearestExercise } from './understand.js';

export const QUESTION_RE = /(몇\s*(개|번|회|세트|분|시간|키로|킬로|km|미터|라운드|일)|얼마나|뭐\s*(했|했어|했지|했더라|했나)|무슨\s*운동|어떤\s*운동|기록\s*(좀\s*)?(알려|말해|읽어|보여)|알려\s*줘|말해\s*줘|총\s*몇)/;

export const isQuestion = (text) => QUESTION_RE.test(String(text || ''));

const DAY = 86400000;
/** 받침에 맞는 조사: topic('오늘') → '오늘은', topic('어제') → '어제는' */
export function topic(word) {
  const w = String(word || '');
  const c = w.charCodeAt(w.length - 1) - 0xac00;
  const batchim = c >= 0 && c <= 11171 && c % 28 !== 0;
  return `${w}${batchim ? '은' : '는'}`;
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 말 속 기간 → { from, to, label }. 기간을 말하지 않으면 null */
export function parseRange(text, now = new Date()) {
  const t = String(text || '');
  const today = startOfDay(now);
  const dow = (now.getDay() + 6) % 7; // 월요일 0
  if (/그저께|그제/.test(t)) return { from: today - 2 * DAY, to: today - DAY, label: '그저께' };
  if (/어제/.test(t)) return { from: today - DAY, to: today, label: '어제' };
  if (/오늘/.test(t)) return { from: today, to: today + DAY, label: '오늘' };
  if (/지난\s*주|저번\s*주/.test(t)) return { from: today - (dow + 7) * DAY, to: today - dow * DAY, label: '지난주' };
  if (/이번\s*주|금주/.test(t)) return { from: today - dow * DAY, to: today + DAY, label: '이번 주' };
  if (/지난\s*달|저번\s*달/.test(t)) {
    return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), to: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), label: '지난달' };
  }
  if (/이번\s*달/.test(t)) return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: today + DAY, label: '이번 달' };
  if (/지금까지|전체|전부|통틀어|여태/.test(t)) return { from: 0, to: today + DAY, label: '지금까지' };
  return null;
}

/** 물어본 운동 이름 (기록에 있는 이름 중에서). 없으면 null */
export function findActivity(text, entries) {
  const names = [...new Set(entries.map((e) => e.activity).filter(Boolean))];
  const compact = String(text || '').replace(/\s+/g, '');
  const exact = names.filter((n) => compact.includes(n.replace(/\s+/g, ''))).sort((a, b) => b.length - a.length);
  if (exact.length) return exact[0];
  const vocab = names.map((n) => n.replace(/\s+/g, ''));
  for (const w of String(text || '').split(/\s+/)) {
    const core = (w.match(/^[가-힣]+/)?.[0] || '').replace(/(은|는|을|를|이|가|도|만|으로|로)$/, '');
    const hit = core.length >= 2 ? nearestExercise(core, vocab) : null;
    if (hit) return names[vocab.indexOf(hit)];
  }
  return null;
}

function metricOf(text) {
  const t = String(text || '');
  if (/(뭐|무슨|어떤)\s*운동|뭐\s*했/.test(t)) return 'list';
  if (/세트/.test(t)) return 'sets';
  if (/몇\s*(개|번|회)|횟수/.test(t)) return 'reps';
  if (/몇\s*라운드|라운드/.test(t)) return 'rounds';
  if (/키로|킬로|km|미터|거리/.test(t)) return 'distance';
  if (/몇\s*(분|시간)|얼마나\s*오래/.test(t)) return 'time';
  if (/몇\s*일|며칠/.test(t)) return 'days';
  return 'summary';
}

function totals(list) {
  const t = { reps: 0, sets: 0, rounds: 0, sec: 0, m: 0, days: new Set() };
  for (const e of list) {
    const m = e.metrics || {};
    const sets = m.sets || 1;
    if (m.reps) t.reps += m.reps * sets;
    if (m.reps || m.rounds || m.duration_sec || m.distance_m) t.sets += m.sets || 1;
    if (m.rounds) t.rounds += m.rounds * sets;
    if (m.duration_sec) t.sec += m.duration_sec * (m.rounds || 1) * sets;
    if (m.distance_m) t.m += m.distance_m;
    const d = new Date(e.date);
    t.days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return t;
}

const timeText = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분` : s >= 60 ? `${Math.round(s / 60)}분` : `${s}초`);
const distText = (m) => (m >= 1000 ? `${Math.round(m / 100) / 10}km` : `${m}m`);
const dateText = (iso) => new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });

function describe(t, metric) {
  if (metric === 'sets') return t.sets ? `${t.sets}세트` : null;
  if (metric === 'reps') return t.reps ? `총 ${t.reps}개${t.sets ? `(${t.sets}세트)` : ''}` : null;
  if (metric === 'rounds') return t.rounds ? `${t.rounds}라운드` : null;
  if (metric === 'distance') return t.m ? distText(t.m) : null;
  if (metric === 'time') return t.sec ? timeText(t.sec) : null;
  if (metric === 'days') return `${t.days.size}일`;
  const parts = [];
  if (t.sets) parts.push(`${t.sets}세트`);
  if (t.reps) parts.push(`총 ${t.reps}개`);
  if (t.rounds) parts.push(`${t.rounds}라운드`);
  if (t.sec) parts.push(timeText(t.sec));
  if (t.m) parts.push(distText(t.m));
  return parts.join(', ') || '기록 1건';
}

/**
 * @param {string} text 질문
 * @param {Array} entries 저장된 모든 기록
 * @returns {string} 소리로 읽어 줄 답
 */
export function answerQuestion(text, entries, now = new Date()) {
  const all = Array.isArray(entries) ? entries : [];
  if (!all.length) return '아직 저장된 운동 기록이 없어요.';
  const range = parseRange(text, now) || { from: startOfDay(now), to: startOfDay(now) + DAY, label: '오늘' };
  const activity = findActivity(text, all);
  const metric = metricOf(text);
  const inRange = all.filter((e) => { const t = new Date(e.date).getTime(); return t >= range.from && t < range.to; });
  const list = activity ? inRange.filter((e) => e.activity === activity) : inRange;

  if (metric === 'list' && !activity) {
    if (!inRange.length) return `${topic(range.label)} 운동 기록이 없어요.`;
    const names = [...new Set(inRange.map((e) => e.activity))];
    return `${topic(range.label)} ${names.join(', ')} 했어요. 모두 ${inRange.length}건 기록돼 있어요.`;
  }

  if (!list.length) {
    if (activity) {
      const past = all.filter((e) => e.activity === activity).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (past.length) {
        const last = past[0];
        const sameDay = past.filter((e) => dateText(e.date) === dateText(last.date));
        return `${topic(range.label)} ${activity} 기록이 없어요. 마지막 ${topic(activity)} ${dateText(last.date)}에 ${describe(totals(sameDay), metric === 'list' ? 'summary' : metric) || '기록 1건'} 했어요.`;
      }
      return `${activity} 기록은 아직 없어요.`;
    }
    return `${topic(range.label)} 운동 기록이 없어요.`;
  }

  const t = totals(list);
  const what = describe(t, metric);
  const subject = activity ? topic(activity) : '운동은';
  if (!what) return `${range.label} ${subject} 그 기록이 없어요. ${describe(t, 'summary')} 기록돼 있어요.`;
  const span = range.label === '오늘' || range.label === '어제' || range.label === '그저께' || t.days.size <= 1 ? '' : ` ${t.days.size}일 동안`;
  return `${range.label}${span} ${subject} ${what} 했어요.`;
}
