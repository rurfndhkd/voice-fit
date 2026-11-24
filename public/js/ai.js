// AI 해석: 사용자가 직접 넣은 OpenAI 키로 이 기기에서 OpenAI 를 바로 호출한다.
// - 키는 이 기기(브라우저/앱) 저장소에만 있고, VOICE FIT 서버로는 절대 보내지 않는다.
// - 키가 없으면 AI 를 쓰지 않고 오프라인 해석기로 동작한다.
import { sanitizeParse } from './schema.js';

const KEY_STORE = 'vf.openaiKey.v1';
const BASE = 'https://api.openai.com/v1';
export const AI_MODEL = 'gpt-4.1';
export const STT_MODEL = 'gpt-transcribe';
// Speech endpoint is supported until 2027-01-06; migrate this adapter to Realtime before then.
export const TTS_MODEL = 'gpt-4o-mini-tts';

export async function synthesizeWithAI(text, { signal, rate = 1 } = {}) {
  const key = getUserKey();
  if (!key) return null;
  const response = await withTimeout((timeout) => fetch(`${BASE}/audio/speech`, {
    method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: 'coral', input: String(text).slice(0, 1500),
      response_format: 'mp3', speed: Math.min(1.5, Math.max(0.7, rate)),
      instructions: '자연스럽고 또렷한 한국어로 짧게 안내하세요. 친근하되 과장된 감탄이나 연기 없이 말하세요. 입력 문장을 그대로 읽으세요.' }),
  }), 12000);
  if (!response.ok) throw new Error('tts-unavailable');
  return response.blob();
}

export function getUserKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}
export const hasUserKey = () => Boolean(getUserKey());
export function setUserKey(key) {
  try { localStorage.setItem(KEY_STORE, key.trim()); return true; } catch { return false; }
}
export function clearUserKey() {
  try { localStorage.removeItem(KEY_STORE); } catch { /* 무시 */ }
}
/** 화면 표시용: sk-…abcd */
export function maskKey(key = getUserKey()) {
  return key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '';
}
export const looksLikeKey = (k) => /^sk-[A-Za-z0-9_\-]{20,}$/.test(String(k || '').trim());

async function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}

/** 키가 실제로 동작하는지 확인. { ok, reason: 'invalid'|'quota'|'network'|null } */
export async function testKey(key) {
  try {
    const r = await withTimeout((signal) => fetch(`${BASE}/models/${AI_MODEL}`, {
      signal, headers: { Authorization: `Bearer ${key.trim()}` },
    }), 10000);
    if (r.ok) return { ok: true, reason: null };
    if (r.status === 401) return { ok: false, reason: 'invalid' };
    if (r.status === 429) return { ok: false, reason: 'quota' };
    return { ok: false, reason: `http-${r.status}` };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

const SYSTEM = `너는 운동 기록 앱 VOICE FIT의 음성 명령 해석기다.
사용자의 한국어 발화(음성인식 결과라 오타·띄어쓰기 오류가 있을 수 있음)를 JSON 하나로 변환한다.

출력 형식: {"intent":"log"|"undo"|"unknown","entries":[...],"reply":"...","confidence":0~1}

[log] 운동 기록. entries 각 항목:
{"sport":"종목(예: 헬스, 맨몸운동, 축구, 복싱, 러닝, 수영)",
 "activity":"구체 동작 이름(예: 스쿼트, 벤치프레스, 슈팅 연습, 스파링)",
 "category":"맨몸"|"웨이트"|"유산소"|"구기"|"격투기"|"기타",
 "metrics":{"reps":세트당 횟수,"sets":세트 수,"weight_kg":무게(kg),"duration_sec":시간(초),"distance_m":거리(m),"rounds":라운드 수},
 "note":"부가 메모, 없으면 빈 문자열"}
규칙:
- 말하지 않은 값은 null. 숫자를 지어내지 말 것.
- "15개씩 3세트" → reps 15, sets 3. "15개" 만 말하면 reps 15, sets null.
- 시간은 초, 거리는 미터로 환산. "5킬로"는 러닝·걷기·자전거·수영이면 distance_m 5000, 웨이트면 weight_kg 5.
- 여러 운동을 한 번에 말하면 entries 에 여러 개.
- category: 무게를 말하지 않은 스쿼트·푸시업·런지·플랭크·버피 등은 "맨몸", 무게(kg)를 말하면 "웨이트".
- 종목 경기 자체를 했다고 하면 activity 는 "<종목> 경기"로. activity 를 "운동"·"뛰기" 처럼 뭉뚱그리지 말 것.
  예: "풋살 40분 뛰었고 슈팅 연습도 30개 했어" → [{"sport":"풋살","activity":"풋살 경기","category":"구기","metrics":{"duration_sec":2400}}, {"sport":"풋살","activity":"슈팅 연습","category":"구기","metrics":{"reps":30}}]
- 음성인식 오타는 가장 그럴듯한 운동 이름으로 고친다(예: 스쿼드→스쿼트, 벤치 프래스→벤치프레스).
- 운동 이름만 말하면(예: "스쿼트", "스쿼트 할게") intent 는 log, metrics 는 모두 null. activity 에 "할게" 같은 동사는 넣지 말 것.
- "한 세트 더", "아까 그거 또" 처럼 이전 기록을 가리키면 입력의 last 를 참고해 같은 운동으로 채운다(sets 는 말한 만큼, 기본 1).
[undo] "취소", "방금 거 지워" 등 마지막 기록 삭제 요청. entries 는 [].
[unknown] 운동 기록과 무관하거나 해석할 수 없음. entries 는 [].

confidence: 이 해석이 사용자의 뜻과 맞을 확률(0~1). 운동 이름이나 숫자가 음성인식 오류로 애매하거나 여러 뜻으로 읽히면 낮게(0.7 미만) 준다. 분명하면 0.9 이상.
reply: 사용자에게 음성으로 읽어줄 짧고 힘찬 한국어 한 문장(35자 이내). 예: "스쿼트 15회 3세트, 기록했어요!"`;

/** 말 → 기록 JSON. 실패하면 null (호출한 쪽이 오프라인 해석기로 대체) */
export async function parseWithAI(text, last) {
  const key = getUserKey();
  if (!key) return null;
  const lastSlim = last ? { sport: last.sport, activity: last.activity, category: last.category, metrics: last.metrics } : null;
  try {
    const r = await withTimeout((signal) => fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify({ text: String(text).slice(0, 500), last: lastSlim }) },
        ],
      }),
    }), 12000);
    if (!r.ok) return null;
    const data = await r.json();
    return sanitizeParse(JSON.parse(data.choices?.[0]?.message?.content || '{}'));
  } catch {
    return null;
  }
}

/** 녹음 → 텍스트 (브라우저 음성인식이 없는 기기용). 키가 없으면 null */
export async function transcribeWithAI(blob, { signal, context = '' } = {}) {
  const key = getUserKey();
  if (!key) return null;
  for (const model of [STT_MODEL, 'gpt-4o-transcribe']) {
    signal?.throwIfAborted();
    const fd = new FormData();
    const type = blob.type || '';
    fd.append('file', blob, type.includes('wav') ? 'speech.wav' : type.includes('mp4') ? 'speech.mp4' : type.includes('ogg') ? 'speech.ogg' : 'speech.webm');
    fd.append('model', model);
    if (model !== STT_MODEL) fd.append('language', 'ko');
    fd.append('prompt', `한국어 운동 기록 앱. 스쿼트, 벤치프레스, 데드리프트, 푸시업, 플랭크, 랫풀다운, 휴식, 세트, 횟수, 킬로그램. ${String(context).slice(0, 350)}`);
    const r = await withTimeout((timeout) => fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${key}` }, body: fd,
    }), 30000);
    if (!r.ok) {
      const error = await r.json().catch(() => ({}));
      if (model === STT_MODEL && (r.status === 404 || error.error?.code === 'model_not_found')) continue;
      throw Object.assign(new Error('transcription-failed'), { code: r.status === 401 ? 'invalid-key' : r.status === 429 ? 'quota' : 'upstream' });
    }
    const data = await r.json();
    return String(data.text || '').trim() || null;
  }
  throw Object.assign(new Error('model-unavailable'), { code: 'upstream' });
}
