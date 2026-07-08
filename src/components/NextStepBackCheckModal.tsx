import { useEffect } from "react";
import { useCanvasStore } from "@/store/canvasStore";

/**
 * "Next" interception for 2-sided designs — a last-chance, price-transparent
 * confirmation before proceeding to the Preview / Finalize step.
 *
 * Opened from the TopBar "Next" button only when a back side exists.
 *   • "Keep it"  (green) → proceeds with the original Next action
 *                          (opens the Preview modal).
 *   • "Remove back" (red) → does NOT delete directly; it closes this modal
 *                          and strictly opens ConfirmDeleteBackModal so the
 *                          user gives a final, explicit deletion confirmation.
 */
export function NextStepBackCheckModal() {
  const open = useCanvasStore((s) => s.nextBackCheckOpen);
  const setOpen = useCanvasStore((s) => s.setNextBackCheckOpen);
  const setPreviewOpen = useCanvasStore((s) => s.setPreviewOpen);
  const setConfirmDeleteBackOpen = useCanvasStore(
    (s) => s.setConfirmDeleteBackOpen
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  // "Keep it" → proceed with the original Next action.
  const onKeep = () => {
    setOpen(false);
    setPreviewOpen(true);
  };

  // "Remove back" → never deletes here; hand off to the strict confirm modal.
  const onRemoveBack = () => {
    setOpen(false);
    setConfirmDeleteBackOpen(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="next-back-check-title"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-vp-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-7 pt-7 pb-2 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#16a34a"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <h2
            id="next-back-check-title"
            className="mt-4 text-[17px] font-semibold text-vp-ink leading-snug"
          >
            Back side added and price will be calculated accordingly.
          </h2>
          <p className="mt-1.5 text-[13.5px] text-vp-ink/70 leading-relaxed">
            Are you sure you want to keep it?
          </p>
        </div>
        <div className="px-7 pb-7 pt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRemoveBack}
            className="h-11 px-5 rounded-xl text-[13.5px] font-semibold text-red-600 border border-red-300 hover:bg-red-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            Remove back
          </button>
          <button
            type="button"
            onClick={onKeep}
            autoFocus
            className="h-11 px-6 rounded-xl text-[13.5px] font-semibold text-white bg-green-600 hover:bg-green-700 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-300"
          >
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}
