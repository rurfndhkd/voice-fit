// PLAN 13 · 운동 종료 후 결과 요약. 실제로 기록된 숫자만 쓴다(지어내지 않음).
import { restLabel } from './commands.js';

// 세트는 말한 경우와 횟수·라운드형 운동만 센다 (요가 30분 같은 시간 기록은 '1세트'로 보이지 않게)
const setsOf = (m) => m.sets || (m.reps || m.rounds ? 1 : 0);

/**
 * @param {Array} entries 이번 운동에서 저장된 기록들 (시간순)
 * @param {{ startedAt: number, endedAt: number, restSec: number }} times ms 타임스탬프와 실제 쉰 시간(초)
 */
export function summarize(entries, { startedAt, endedAt, restSec = 0 } = {}) {
  const byActivity = new Map();
  for (const e of entries || []) {
    const m = e.metrics || {};
    const k = e.activity || '운동';
    if (!byActivity.has(k)) byActivity.set(k, { activity: k, sets: 0, reps: 0, perSet: [], rounds: 0, durationSec: 0, distanceM: 0, weights: new Set() });
    const a = byActivity.get(k);
    const sets = setsOf(m);
    a.sets += sets;
    if (m.reps) { a.reps += m.reps * (m.sets || 1); for (let i = 0; i < (m.sets || 1); i++) a.perSet.push(m.reps); }
    if (m.rounds) a.rounds += m.rounds * (m.sets || 1);
    if (m.duration_sec) a.durationSec += m.duration_sec * (m.rounds || 1) * (m.sets || 1);
    if (m.distance_m) a.distanceM += m.distance_m;
    if (m.weight_kg) a.weights.add(m.weight_kg);
  }
  const items = [...byActivity.values()].map((a) => {
    const parts = [];
    if (a.sets) parts.push(`${a.sets}세트`);
    if (a.reps) parts.push(`총 ${a.reps}개`);
    if (a.rounds) parts.push(`${a.rounds}라운드`);
    if (a.durationSec) parts.push(restLabel(Math.round(a.durationSec)));
    if (a.distanceM) parts.push(a.distanceM >= 1000 ? `${Math.round(a.distanceM / 100) / 10}km` : `${a.distanceM}m`);
    if (a.weights.size) parts.push(`${[...a.weights].join('·')}kg`);
    const detail = a.perSet.length > 1 ? a.perSet.join(' · ') : '';
    return { activity: a.activity, text: parts.join(' · ') || '기록됨', detail };
  });
  const totalSec = Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt > startedAt ? Math.round((endedAt - startedAt) / 1000) : 0;
  const rest = Math.round(restSec || 0);
  const spoken = items.length
    ? `오늘 운동 요약이에요. ${items.map((i) => `${i.activity} ${i.text}`).join(', ')}. 운동 시간 ${duration(totalSec)}${rest ? `, 휴식 ${duration(rest)}` : ''}.`
    : '';
  return { items, totalSec, restSec: rest, spoken };
}

/** 125 → "2분 5초", 3700 → "1시간 1분" */
export function duration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s >= 3600) return `${Math.floor(s / 3600)}시간${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}분` : ''}`;
  if (s >= 60) return `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`;
  return `${s}초`;
}
