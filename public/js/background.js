// 안드로이드 앱: 홈 화면(백그라운드)·꺼진 화면에서도 호출어 듣기 — WakeService 플러그인 연결부.
// 웹에서는 모든 기능이 '지원 안 함'으로 동작한다.
import { isNative, nativePlugin } from './config.js';

const plugin = () => (isNative ? nativePlugin('WakeService') : null);

export const backgroundSupported = () => Boolean(plugin());

const NO_STATUS = { running: false, overlay: false, notifications: false, battery: false };

export async function bgStatus() {
  const p = plugin();
  if (!p) return NO_STATUS;
  return p.status().catch(() => NO_STATUS);
}

/** 서비스 시작. 버블·백그라운드 호출에는 '다른 앱 위에 표시' 권한이 필요하다 */
export async function bgStart(wakeWord, gate = {}) {
  const p = plugin();
  if (!p || !wakeWord) return false;
  try {
    await p.start({ wakeWord, gateEnabled: Boolean(gate.enabled), gateLevel: Number(gate.level) || 5, voiceLock: Boolean(gate.voiceLock) });
    return true;
  } catch { return false; }
}

export async function bgStop() {
  const p = plugin();
  if (p) await p.stop().catch(() => {});
}

export async function bgRequestPermissions() {
  const p = plugin();
  if (!p) return;
  await p.requestNotifications().catch(() => {});
  const s = await bgStatus();
  if (!s.overlay) await p.openOverlaySettings().catch(() => {});
  else if (!s.battery) await p.openBatterySettings().catch(() => {});
}

/**
 * 배터리 최적화 끄기/켜기.
 * exempt=true: 최적화에서 빼 달라는 시스템 창(사용자가 '허용')
 * exempt=false: 다시 켜기 — 안드로이드는 앱이 직접 되돌리는 걸 막아서, 이 앱의 배터리 설정 화면을 연다
 */
export async function bgOpenBattery(exempt = true) {
  const p = plugin();
  if (p) await p.openBatterySettings({ exempt }).catch(() => {});
}

export async function bgMoveToBack() {
  const p = plugin();
  if (p) await p.moveToBack().catch(() => {});
}

/** 대화 세션 시작/끝 알림: 세션 중에는 화면이 꺼져도 앱이 계속 듣고, 잠금화면 위에 보인다 */
let sessionOn = null;
export async function bgSession(active) {
  const p = plugin();
  if (!p || sessionOn === active) return;
  sessionOn = active;
  await p.setSession({ active }).catch(() => {});
}

/** 잠금 해제 요청. 웹·잠금 아님이면 바로 true */
export async function bgUnlock() {
  const p = plugin();
  if (!p) return true;
  const r = await p.requestUnlock().catch(() => ({ unlocked: false }));
  return Boolean(r?.unlocked);
}

/** 휴식 종료 알림을 앱(네이티브)에 맡긴다 — 화면이 꺼져도 제시간에 울리도록. ms<=0 이면 취소. 웹이면 false */
export async function bgRestAlarm(ms) {
  const p = plugin();
  if (!p?.restAlarm) return false;
  await p.restAlarm({ ms: Math.max(0, Math.round(ms)) }).catch(() => {});
  return true;
}

/** 앱이 보이는지(화면 꺼짐·잠금 여부 포함) / 백그라운드에서 호출됐는지 / 휴식 종료 이벤트 */
export async function bgListen({ onAppState, onWake, onRestDone }) {
  const p = plugin();
  if (!p) return;
  await p.addListener('appState', (d) => onAppState?.(Boolean(d?.active), { screenOff: Boolean(d?.screenOff), locked: Boolean(d?.locked) }));
  await p.addListener('wakeDetected', (d) => onWake?.(d?.rest || ''));
  await p.addListener('restDone', () => onRestDone?.());
}
