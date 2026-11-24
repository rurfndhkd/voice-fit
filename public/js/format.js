// 화면·음성 안내에 쓰는 표시 형식.
export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return [h && `${h}시간`, m && `${m}분`, s && `${s}초`].filter(Boolean).join(' ') || '0초';
}

export function metricChips(m = {}) {
  const out = [];
  if (m.weight_kg) out.push(`${m.weight_kg}kg`);
  if (m.reps) out.push(`${m.reps}회`);
  if (m.sets) out.push(`${m.sets}세트`);
  if (m.rounds) out.push(`${m.rounds}라운드`);
  if (m.duration_sec) out.push(formatDuration(m.duration_sec));
  if (m.distance_m) out.push(m.distance_m >= 1000 ? `${+(m.distance_m / 1000).toFixed(2)}km` : `${m.distance_m}m`);
  return out;
}

export const hasMetrics = (e) => Object.values(e?.metrics || {}).some((v) => v !== null && v !== undefined);

export function describe(e) {
  const chips = metricChips(e.metrics);
  return `${e.activity}${chips.length ? ` ${chips.join(' ')}` : ''}`;
}

const DIGITS = ['공', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

/** 전화번호를 한 자리씩 읽기 좋게 바꾼다. 010-1234-5678 → "공일공, 일이삼사, 오육칠팔" */
export function spellNumber(number) {
  const raw = String(number || '').replace(/[^\d+]/g, '');
  if (!raw) return '알 수 없는 번호';
  let digits = raw.replace(/^\+82/, '0').replace(/\D/g, '');
  let groups;
  if (/^01\d{8,9}$/.test(digits)) groups = [digits.slice(0, 3), digits.slice(3, -4), digits.slice(-4)];
  else if (/^02\d{7,8}$/.test(digits)) groups = [digits.slice(0, 2), digits.slice(2, -4), digits.slice(-4)];
  else if (/^0\d{9,10}$/.test(digits)) groups = [digits.slice(0, 3), digits.slice(3, -4), digits.slice(-4)];
  else groups = digits.match(/.{1,4}/g);
  return groups.map((g) => [...g].map((d) => DIGITS[d]).join('')).join(', ');
}

export function formatNumber(number) {
  const d = String(number || '').replace(/^\+82/, '0').replace(/\D/g, '');
  if (/^01\d{8,9}$/.test(d) || /^0[3-9]\d{8,9}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, -4)}-${d.slice(-4)}`;
  if (/^02\d{7,8}$/.test(d)) return `02-${d.slice(2, -4)}-${d.slice(-4)}`;
  return number || '';
}
