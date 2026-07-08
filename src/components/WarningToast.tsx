import { useCanvasStore } from "@/store/canvasStore";

/**
 * Floating top-right toast. Driven by `canvasWarning` + `canvasWarningType`
 * in the store. Two visual variants:
 *   • warning (amber) — out-of-bounds moves, low-res / blurry images, errors
 *   • success (green) — positive confirmations, e.g. "Back side added"
 *
 * Auto-hides after 5s via the store's timer; clearing the warning early
 * cancels the pending hide. Hidden during Preview Mode so the polished
 * print preview isn't cluttered with editor toasts.
 */
export function WarningToast() {
  const message = useCanvasStore((s) => s.canvasWarning);
  const type = useCanvasStore((s) => s.canvasWarningType);
  const warningId = useCanvasStore((s) => s.canvasWarningId);
  const previewMode = useCanvasStore((s) => s.previewMode);
  if (!message || previewMode) return null;

  const isSuccess = type === "success";
  const card = isSuccess
    ? "bg-green-50 border-green-500 text-green-900"
    : "bg-amber-50 border-amber-500 text-amber-900";
  const iconColor = isSuccess ? "text-green-600" : "text-amber-600";

  return (
    <div
      role={isSuccess ? "status" : "alert"}
      aria-live={isSuccess ? "polite" : "assertive"}
      // Key on the monotonic nonce (not the string) so EVERY toast —
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
      <div
        className={`flex items-start gap-3 border-2 rounded-2xl p-5 shadow-2xl ${card}`}
      >
        {isSuccess ? (
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
            className={`mt-0.5 shrink-0 ${iconColor}`}
            aria-hidden
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        ) : (
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
            className={`mt-0.5 shrink-0 ${iconColor}`}
            aria-hidden
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        )}
        <span className="text-base font-semibold leading-snug">{message}</span>
      </div>
    </div>
  );
}
