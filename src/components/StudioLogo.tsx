/**
 * Sewing-button logo for the trims.in studio.
 *
 * Rendered as inline SVG so it scales crisply at any DPI and inherits the
 * `.vp-logo-roll` animation defined in `index.css` (a calm 5-second linear
 * rotation that mimics a button rolling).
 *
 * The colours mirror a brushed brass / golden plastic button: a darker
 * outer rim, a lighter face, a subtle inner ring, and four thread holes.
 */
export function StudioLogo({ size = 32 }: { size?: number }) {
  return (
    <span
      role="img"
      aria-label="trims.in studio"
      className="inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <svg
        className="vp-logo-roll"
        width={size}
        height={size}
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="vp-btn-face" cx="40%" cy="38%" r="68%">
            <stop offset="0%" stopColor="#fbe089" />
            <stop offset="55%" stopColor="#f1c14a" />
            <stop offset="100%" stopColor="#c9952a" />
          </radialGradient>
        </defs>
        {/* Outer rim */}
        <circle cx="16" cy="16" r="15" fill="#a07013" />
        {/* Button face */}
        <circle cx="16" cy="16" r="13.5" fill="url(#vp-btn-face)" />
        {/* Inner concentric ring */}
        <circle
          cx="16"
          cy="16"
          r="9.5"
          fill="none"
          stroke="#a07013"
          strokeOpacity="0.55"
          strokeWidth="0.9"
        />
        {/* Four thread holes */}
        <g fill="#5b3f08">
          <circle cx="12.4" cy="12.4" r="1.7" />
          <circle cx="19.6" cy="12.4" r="1.7" />
          <circle cx="12.4" cy="19.6" r="1.7" />
          <circle cx="19.6" cy="19.6" r="1.7" />
        </g>
        {/* Specular highlight to sell the rolling motion */}
        <circle cx="11" cy="10" r="2.4" fill="#fff7d6" fillOpacity="0.7" />
      </svg>
    </span>
  );
}
