// 마이크 장치 고르기 (PLAN 2 · MUST 1) — VoiceListener 플러그인 연결부.
// 안드로이드 앱에서만 동작한다. 웹은 브라우저 기본 마이크를 쓴다.
import { isNative, nativePlugin } from './config.js';

const plugin = () => (isNative ? nativePlugin('VoiceListener') : null);

export const micPickSupported = () => Boolean(plugin()?.listMics);

const EMPTY = { devices: [], selected: 'auto', active: 'auto' };

/** { devices:[{key,name,kind}], selected, active } — active 는 지금 실제로 쓰는 장치 ('auto' = 휴대폰 기본) */
export async function listMics() {
  const p = plugin();
  if (!p?.listMics) return EMPTY;
  return p.listMics().catch(() => EMPTY);
}

export async function setMic(key) {
  const p = plugin();
  if (!p?.setMic) return EMPTY;
  return p.setMic({ key }).catch(() => EMPTY);
}

export async function onMicsChanged(fn) {
  const p = plugin();
  if (p?.addListener) await p.addListener('micsChanged', (d) => fn?.(d || EMPTY));
}

const KIND_ICON = { phone: '📱', wired: '🎧', usb: '🎧', bluetooth: '🎧' };
export const micIcon = (kind) => KIND_ICON[kind] || '🎙️';

/**
 * 화면에 보일 상태 한 줄.
 * - 고른 장치가 연결 안 돼 있으면: 끊김 안내 + 기본 마이크로 듣는 중
 */
export function micSummary({ devices, selected, active }) {
  if (selected === 'auto') return { text: '휴대폰 기본 마이크', warn: false };
  const chosen = devices.find((d) => d.key === selected);
  if (!chosen || active !== selected) return { text: '고른 마이크 연결이 끊겼어요 · 지금은 휴대폰 마이크로 들어요', warn: true };
  return { text: chosen.name, warn: false };
}
