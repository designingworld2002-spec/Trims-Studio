import { useEffect } from "react";
import { useCanvasStore } from "@/store/canvasStore";

/**
 * Strict, reusable "remove the back design?" confirmation.
 *
 * Driven by global store state (`confirmDeleteBackOpen`) so it can be
 * triggered from BOTH the SideToggle trash button and the "Remove back"
 * path of the Next-step check modal. Deliberately price-agnostic — it
 * never states an amount, only that the back-side charge will be removed.
 *
 * "Remove" runs `clearBackDesign` then closes; "Cancel" / backdrop /
 * Escape just close.
 */
export function ConfirmDeleteBackModal() {
  const open = useCanvasStore((s) => s.confirmDeleteBackOpen);
  const setOpen = useCanvasStore((s) => s.setConfirmDeleteBackOpen);
  const clearBackDesign = useCanvasStore((s) => s.clearBackDesign);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const onRemove = () => {
    clearBackDesign();
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-back-title"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-vp-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-2 flex items-start gap-3.5">
          <div className="shrink-0 w-11 h-11 rounded-full bg-red-50 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#dc2626"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="confirm-delete-back-title"
              className="text-[16px] font-semibold text-vp-ink leading-tight"
            >
              Remove the back design?
            </h2>
            <p className="mt-2 text-[13px] text-vp-ink/70 leading-relaxed">
              Are you sure you want to remove the back design? Additional
              charges for the back side will be removed.
            </p>
          </div>
        </div>
        <div className="px-6 pb-6 pt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-10 px-5 rounded-lg text-[13px] font-semibold text-vp-ink/80 border border-vp-border hover:bg-vp-rail transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vp-accent/30"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onRemove}
            autoFocus
            className="h-10 px-5 rounded-lg text-[13px] font-semibold text-white bg-red-600 hover:bg-red-700 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
