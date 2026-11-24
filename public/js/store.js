// 기기 안 저장소 (localStorage). 접근이 막힌 환경에서도 앱이 멈추지 않도록 메모리로 대체한다.
const KEYS = { entries: 'vf.entries.v1', settings: 'vf.settings.v1' };
const memory = {};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return memory[key] ?? fallback;
  }
}
function write(key, value) {
  memory[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 메모리에만 유지 */ }
}

export const DEFAULT_SETTINGS = {
  theme: 'dark-sport',
  voiceFeedback: true,
  naturalVoice: false, // AI 목소리(추가 사용료)는 사용자가 직접 켤 때만
  rate: 1.05,
  engine: 'auto', // auto | browser | openai
  wakeWord: '',
  listenMode: true, // 호출어가 있으면 앱을 열자마자 듣는다
  backgroundListen: true, // 안드로이드 앱: 홈 화면에서도 버블로 듣기
  noiseGate: false, // 주변 소리 배제 (음성 감지 기준보다 작은 소리는 무시)
  gateLevel: 5,
  voiceLock: false, // 등록된 내 목소리만 듣기 (다른 사람 목소리·소음은 무음 처리)
  voiceBannerDismissed: false, // 음성 감지 기준 (안드로이드 음성인식 음량 단위, 대략 -2 조용함 ~ 12 큰 목소리)
  settingsVersion: 4,
};

export function getSettings() {
  const saved = read(KEYS.settings, {});
  // v3 이전에 저장된 설정은 '호출어 듣기 꺼짐'이 기본이었으므로 켜짐으로 옮긴다
  if ((saved.settingsVersion || 0) < 3) {
    saved.listenMode = true;
    saved.settingsVersion = 3;
  }
  // v4: AI 목소리는 추가 사용료가 들어서 기본 꺼짐으로 바꾼다 (이전에 자동으로 켜진 값도 한 번 끈다)
  if (saved.settingsVersion < 4) {
    saved.naturalVoice = false;
    saved.settingsVersion = 4;
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write(KEYS.settings, next);
  return next;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function getEntries() {
  const list = read(KEYS.entries, []);
  return Array.isArray(list) ? list : [];
}

/** 새 기록들을 저장하고, 저장된 기록(id·날짜 포함)을 돌려준다. */
export function addEntries(entries, rawText, source) {
  const now = new Date().toISOString();
  const saved = entries.map((e) => ({ ...e, id: uid(), date: now, raw_text: rawText, source }));
  write(KEYS.entries, [...getEntries(), ...saved]);
  return saved;
}

export function removeEntries(ids) {
  const set = new Set(ids);
  write(KEYS.entries, getEntries().filter((e) => !set.has(e.id)));
}

/** 지웠던 기록을 되살린다 (id·날짜 그대로, 시간순 유지) */
export function restoreEntries(list) {
  const current = getEntries();
  const have = new Set(current.map((e) => e.id));
  const merged = [...current, ...list.filter((e) => e && !have.has(e.id))];
  merged.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  write(KEYS.entries, merged);
}

export function lastEntry() {
  const list = getEntries();
  return list[list.length - 1] || null;
}

/** Replace only the still-current last entry, preserving its identity and timestamp. */
export function correctLastEntry(expectedId, entry, rawText) {
  const list = getEntries();
  const last = list[list.length - 1];
  if (!last || last.id !== expectedId) return null;
  const updated = { ...last, ...entry, id: last.id, date: last.date, raw_text: rawText, source: 'ai' };
  list[list.length - 1] = updated;
  write(KEYS.entries, list);
  return updated;
}

export function clearEntries() {
  write(KEYS.entries, []);
}
