import { useEffect } from "react";

/**
 * Generic confirm-delete dialog used by destructive actions in the
 * Studio (e.g. "Remove back design"). Styled to match the rest of the
 * editor: blurred backdrop, rounded card, Cancel + danger-red Delete.
 *
 * Controlled by the caller — `open` drives mount/animation, `onConfirm`
 * fires the destructive action, `onCancel` simply closes. Escape +
 * backdrop-click both cancel.
 */
export function ConfirmDeleteModal({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Escape to cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/45 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-vp-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-2 flex items-start gap-3">
          <div className="shrink-0 w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
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
              id="confirm-delete-title"
              className="text-[15px] font-semibold text-vp-ink leading-tight"
            >
              {title}
            </h2>
            <p className="mt-1.5 text-[13px] text-vp-ink/70 leading-snug">
              {message}
            </p>
          </div>
        </div>
        <div className="px-5 pb-5 pt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-4 rounded-lg text-[13px] font-medium text-vp-ink/75 hover:bg-vp-rail transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className="h-9 px-4 rounded-lg text-[13px] font-semibold text-white bg-red-600 hover:bg-red-700 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
