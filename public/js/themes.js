// 테마 목록. styles.css 의 [data-theme] 블록과 이름을 맞춘다.
export const THEMES = [
  { id: 'dark-sport', name: '다크 스포티', swatch: ['#0b0d10', '#c6ff3d'], meta: '#0b0d10' },
  { id: 'neon-blue', name: '네온 블루', swatch: ['#060b16', '#2ee6ff'], meta: '#060b16' },
  { id: 'sunset', name: '선셋 오렌지', swatch: ['#140b0a', '#ff7a2f'], meta: '#140b0a' },
  { id: 'light', name: '라이트', swatch: ['#ffffff', '#ff5a1f'], meta: '#f4f5f7' },
];

export function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.meta);
  return theme.id;
}
