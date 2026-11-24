// 실행 환경 설정.
export const isNative = Boolean(window.Capacitor?.isNativePlatform?.());

/** Capacitor 네이티브 플러그인 (앱이 아니면 undefined) */
export const nativePlugin = (name) => window.Capacitor?.Plugins?.[name];
