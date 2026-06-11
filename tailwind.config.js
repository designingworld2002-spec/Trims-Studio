/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Premium palette — aligned to Tailwind's neutral scales so the
        // Studio reads as a polished, modern design tool. Existing
        // components that reference these tokens (e.g. `border-vp-border`,
        // `bg-vp-rail`) automatically pick up the upgraded values.
        vp: {
          // Primary CTA — softer sky blue to match Vistaprint's modern,
          // approachable feel (was the harsher blue-600).
          blue: "#38bdf8",           // ← Tailwind sky-400
          "blue-hover": "#0ea5e9",   // ← sky-500
          "blue-light": "#e0f2fe",   // ← sky-100
          // Active tool / dark accent — sleek slate, matches the
          // Vistaprint left-border highlight aesthetic.
          ink: "#0f172a",            // ← slate-900
          accent: "#1e293b",         // ← slate-800
          // Workspace surround — soft warm-ish gray (Vistaprint's actual
          // canvas backdrop is closer to `#f4f5f7` than cool slate).
          rail: "#f4f5f7",
          // Hairline strokes everywhere.
          border: "#e5e7eb",         // ← gray-200
          // Secondary copy.
          muted: "#6b7280",          // ← gray-500
          // Bleed / safety guide accents (kept as-is — semantic).
          safety: "#22c55e",
          bleed: "#eab308",
        },
      },
      boxShadow: {
        // Subtler card shadow + a refined popover shadow that mimics
        // Tailwind's `shadow-xl` for floating menus.
        "vp-card": "0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)",
        "vp-pop":
          "0 10px 15px -3px rgba(15,23,42,0.10), 0 4px 6px -4px rgba(15,23,42,0.08)",
        // "Paper" — the canvas card. Soft, elevated, modern.
        "vp-paper":
          "0 20px 25px -5px rgba(15,23,42,0.10), 0 8px 10px -6px rgba(15,23,42,0.06)",
      },
      transitionTimingFunction: {
        "vp-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
    },
  },
  plugins: [],
};
