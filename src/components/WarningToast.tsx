import { useCanvasStore } from "@/store/canvasStore";

/**
 * Floating top-right warning toast. Driven by `canvasWarning` in the
 * store — set/cleared by the canvas movement listeners and the
 * low-resolution / blur image detectors. Auto-hides after 5s via the
 * store's timer; clearing the warning early (e.g. when the user drags
 * an object back into the safe area) cancels the pending hide.
 *
 * Hidden during Preview Mode so the polished print preview isn't
 * cluttered with editor warnings.
 */
export function WarningToast() {
  const message = useCanvasStore((s) => s.canvasWarning);
  const warningId = useCanvasStore((s) => s.canvasWarningId);
  const previewMode = useCanvasStore((s) => s.previewMode);
  if (!message || previewMode) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      // Key on the monotonic nonce (not the string) so EVERY warning —
      // even an identical consecutive one — re-mounts and replays the
      // slide-in animation.
      key={warningId}
      className="absolute top-4 right-4 z-40 max-w-md pointer-events-none"
      style={{ animation: "slideInRight 0.3s ease-out forwards" }}
    >
      {/* Inline keyframes — self-contained so it works regardless of
          the global CSS / Tailwind arbitrary-class compile step. */}
      <style>{`
        @keyframes slideInRight {
          0% { transform: translateX(100%); opacity: 0; }
          100% { transform: translateX(0); opacity: 1; }
        }
      `}</style>
      <div className="flex items-start gap-3 bg-amber-50 border-2 border-amber-500 text-amber-900 rounded-2xl p-5 shadow-2xl">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 shrink-0 text-amber-600"
          aria-hidden
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-base font-semibold leading-snug">{message}</span>
      </div>
    </div>
  );
}
