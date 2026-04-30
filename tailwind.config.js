/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Vistaprint-ish palette
        vp: {
          blue: "#0066ff",
          "blue-hover": "#0052cc",
          "blue-light": "#e6f0ff",
          ink: "#0a1f44",
          rail: "#f0f2f5",
          border: "#e3e6eb",
          muted: "#6b7280",
          safety: "#22c55e",
          bleed: "#eab308",
        },
      },
      boxShadow: {
        "vp-card": "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
        "vp-pop": "0 8px 24px rgba(0,0,0,0.12)",
      },
    },
  },
  plugins: [],
};
