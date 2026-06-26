import { useState } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";

/**
 * Floating Front / Back side switcher — pill-shaped segmented control
 * pinned to the bottom-centre of the workspace. Renders only for
 * products with `supportsBackSide: true`. Suppressed in Preview Mode.
 *
 * Design:
 *   • Two halves of a single rounded pill, the active half lifted with
 *     a white card + soft shadow so it reads as a physical toggle.
 *   • Trash-can button sits flush to the right of the pill once a back
 *     design exists, with a separator pip so it never feels grafted on.
 */
export function SideToggle() {
  const supportsBack = useCanvasStore(
    (s) => s.productConfig.supportsBackSide
  );
  const activeSide = useCanvasStore((s) => s.activeSide);
  const setActiveSide = useCanvasStore((s) => s.setActiveSide);
  const previewMode = useCanvasStore((s) => s.previewMode);
  const backDesign = useCanvasStore((s) => s.backDesign);
  const setBackChooserOpen = useCanvasStore((s) => s.setBackChooserOpen);
  const clearBackDesign = useCanvasStore((s) => s.clearBackDesign);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!supportsBack || previewMode) return null;

  const sides: { key: "front" | "back"; label: string }[] = [
    { key: "front", label: "Front" },
    { key: "back", label: "Back" },
  ];

  const onPick = (side: "front" | "back") => {
    if (side === "back" && activeSide !== "back" && !backDesign) {
      setBackChooserOpen(true);
      return;
    }
    setActiveSide(side);
  };

  const onClearBack = () => setConfirmOpen(true);
  const onConfirmClear = () => {
    setConfirmOpen(false);
    clearBackDesign();
  };

  const showTrash = backDesign || activeSide === "back";

  return (
    <div
      className="absolute bottom-4 right-4 z-20 flex items-center gap-2"
      aria-label="Switch side"
    >
      {/* Segmented pill */}
      <div className="flex items-center bg-white/95 backdrop-blur-sm border border-vp-border rounded-full p-1 shadow-vp-pop">
        {sides.map((s) => {
          const active = activeSide === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onPick(s.key)}
              aria-pressed={active}
              className={[
                "relative h-9 px-5 rounded-full text-[13px] font-semibold tracking-wide transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vp-accent/40",
                active
                  ? "bg-vp-ink text-white shadow-[0_2px_8px_-2px_rgba(0,0,0,0.25)]"
                  : "text-vp-ink/65 hover:text-vp-ink",
              ].join(" ")}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Trash — only after a back design exists or is being designed */}
      {showTrash && (
        <button
          type="button"
          onClick={onClearBack}
          title="Remove back design"
          aria-label="Remove back design"
          className={[
            "flex items-center justify-center h-9 w-9 rounded-full",
            "bg-white/95 backdrop-blur-sm border border-vp-border shadow-vp-pop",
            "text-vp-ink/60 hover:text-red-600 hover:border-red-200 hover:bg-red-50",
            "transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300",
          ].join(" ")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
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
        </button>
      )}
      <ConfirmDeleteModal
        open={confirmOpen}
        title="Remove back design?"
        message="Your back-side artwork will be discarded. This can't be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={onConfirmClear}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
