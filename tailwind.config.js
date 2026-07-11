/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./*.html", 
    "./**/*.html", /* Added this just in case you ever put HTML in subfolders */
    "./*.js"
  ],
  theme: {
    extend: {
      animation: {
        'spin-slow': 'spin 15s linear infinite',
        'spin-reverse': 'spin 15s linear infinite reverse',
      }
    },
  },
  plugins: [],
}