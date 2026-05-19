/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#0B1220",
        surface: "#131A2A",
        electric: "#3B82F6",
        copper: "#D4A574",
        offwhite: "#F5F5F0",
        muted: "#94A3B8",
      },
      fontFamily: {
        fraunces: ['Fraunces', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
