/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 다크 터미널 톤에 맞춘 패널 색상
        panel: '#1e1e2e',
        'panel-light': '#2a2a3c',
        // 보조 글씨 회색을 앱 전체에서 한 단계 밝힌다. 이 앱의 gray 는 사실상 글자색으로만 쓰이는데(1.8k 곳 중 배경 4곳),
        // 기본값은 흰 바탕용이라 어두운 패널에서 500 이 대비 3.4:1, 600(입력칸 placeholder 대부분)이 2.2:1 로
        // 모니터를 들여다봐야 보였다. 컴포넌트마다 고치면 새 화면에서 또 생기므로 팔레트에서 고친다.
        // 대비(panel #1e1e2e 기준): 400 8.5 · 500 6.9 · 600 5.2(panel-light 위 4.5) · 700 3.6 — 단계 차이는 유지한다.
        gray: {
          400: '#b4bbc6',
          500: '#a1a9b5',
          600: '#8a929f',
          700: '#6f7785',
        },
      },
    },
  },
  plugins: [],
}
