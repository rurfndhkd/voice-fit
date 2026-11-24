// 전화 제어 연결부.
//  - 안드로이드 앱: 네이티브 플러그인 PhoneBridge (android/.../PhoneBridgePlugin.java)
//      수신 감지 · 연락처 이름 조회 · 받기 · 끊기 · 문자 전송 · 벨소리 무음 · 화면 켜짐 유지
//  - 웹: 브라우저는 전화를 다룰 수 없으므로 '시연 모드'로 같은 흐름을 보여준다.
import { isNative, nativePlugin } from './config.js';

const native = () => (isNative ? nativePlugin('PhoneBridge') : null);

export const phoneMode = () => (native() ? 'native' : 'demo');

const listeners = new Set();
const endListeners = new Set();

export function onIncomingCall(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function onCallEnded(cb) { endListeners.add(cb); return () => endListeners.delete(cb); }
const emitIncoming = (call) => listeners.forEach((cb) => cb(call));
const emitEnded = () => endListeners.forEach((cb) => cb());

let initialized = false;
export async function initPhone() {
  if (initialized) return;
  initialized = true;
  const p = native();
  if (!p) return;
  await p.addListener('incomingCall', (d) => emitIncoming({ number: d?.number || '', name: d?.name || '' }));
  await p.addListener('callEnded', () => emitEnded());
  await p.startListening().catch(() => {});
}

/** 앱: 전화 권한 요청. 결과 { granted: boolean } */
export async function requestPhonePermissions() {
  const p = native();
  if (!p) return { granted: false };
  const r = await p.requestPermissions().catch(() => ({}));
  const granted = ['phone', 'contacts', 'sms'].every((k) => r?.[k] === 'granted');
  if (granted) await p.startListening().catch(() => {});
  return { granted, detail: r };
}

export async function phonePermissionState() {
  const p = native();
  if (!p) return null;
  const r = await p.checkPermissions().catch(() => ({}));
  return ['phone', 'contacts', 'sms'].every((k) => r?.[k] === 'granted');
}

export async function answerCall() {
  const p = native();
  if (p) return p.answer();
  demoState.status = 'answered';
}

export async function rejectCall() {
  const p = native();
  if (p) return p.reject();
  demoState.status = 'rejected';
}

export async function sendSms(number, text) {
  const p = native();
  if (p) return p.sendSms({ number, text });
  demoState.lastSms = { number, text, at: new Date().toISOString() };
}

/** 전화 안내를 알아듣기 쉽게 벨소리를 잠시 끈다 (앱에서만) */
export async function setRingerMuted(muted) {
  const p = native();
  if (p) await p.setRingerMuted({ muted }).catch(() => {});
}

/** 듣기 모드 동안 화면 꺼짐 방지 */
let wakeLock = null;
export async function keepScreenOn(on) {
  const p = native();
  if (p) { await p.keepScreenOn({ on }).catch(() => {}); return true; }
  try {
    if (on) {
      if (!('wakeLock' in navigator)) return false;
      wakeLock = await navigator.wakeLock.request('screen');
      return true;
    }
    await wakeLock?.release();
    wakeLock = null;
  } catch { return false; }
  return true;
}
// 화면이 다시 보이면 웹 Wake Lock 을 다시 잡는다(브라우저가 자동 해제함)
document.addEventListener('visibilitychange', () => {
  if (wakeLock && document.visibilityState === 'visible' && !native()) {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  }
});

/* ---------- 웹 시연 모드 ---------- */
export const demoState = { status: 'idle', lastSms: null };

/** 시연: 전화가 온 것처럼 흐름을 시작한다 */
export function simulateIncomingCall({ number, name }) {
  demoState.status = 'ringing';
  emitIncoming({ number, name: name || '' });
}
export function simulateCallEnded() {
  demoState.status = 'idle';
  emitEnded();
}
