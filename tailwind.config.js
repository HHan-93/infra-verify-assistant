/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 다크 터미널 톤에 맞춘 패널 색상
        panel: '#1e1e2e',
        'panel-light': '#2a2a3c',
      },
    },
  },
  plugins: [],
}
