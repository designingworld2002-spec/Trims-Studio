import { Cloud, Eye, Redo2, Undo2 } from "lucide-react";

const ICON_STROKE = 1.6;
import { useCanvasStore } from "@/store/canvasStore";
import { history } from "@/lib/historyAccessor";
import { StudioLogo } from "./StudioLogo";

export function TopBar() {
  const productTitle = useCanvasStore((s) => s.productTitle);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const lastSavedAt = useCanvasStore((s) => s.lastSavedAt);
  const setPreviewOpen = useCanvasStore((s) => s.setPreviewOpen);
  const setPreviewFlipOpen = useCanvasStore((s) => s.setPreviewFlipOpen);

  return (
    <header className="h-14 bg-white border-b border-gray-100 shadow-sm flex items-center px-2 sm:px-4 shrink-0 gap-1 z-30 relative">
      {/* Logo — animated rolling sewing-button. Text label hides on small screens. */}
      <div className="flex items-center gap-2.5 sm:pr-5 sm:border-r sm:border-vp-border shrink-0">
        <StudioLogo size={32} />
        <span className="font-semibold text-[13px] tracking-tight hidden sm:inline text-vp-ink">
          trims.in studio
        </span>
      </div>

      {/* Product title */}
      <div className="px-2 sm:px-5 text-[13px] font-medium text-vp-ink/70 truncate min-w-0 flex-1 md:flex-initial">
        {productTitle}
      </div>

      {/* Center: auto-save + undo/redo. Hidden on mobile to free up space;
          undo/redo move to the right cluster instead. */}
      <div className="hidden md:flex flex-1 items-center justify-center gap-1">
        <div className="flex items-center gap-1.5 text-[11px] text-vp-muted px-3 font-medium">
          <Cloud className="w-3.5 h-3.5" strokeWidth={ICON_STROKE} />
          <span>{lastSavedAt ? "Saved" : "Not saved yet"}</span>
        </div>
        <button
          aria-label="Undo"
          onClick={() => history.undo()}
          disabled={!canUndo}
          className="w-9 h-9 rounded-lg hover:bg-vp-rail disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors text-vp-ink/70 hover:text-vp-ink"
        >
          <Undo2 className="w-4 h-4" strokeWidth={ICON_STROKE} />
        </button>
        <button
          aria-label="Redo"
          onClick={() => history.redo()}
          disabled={!canRedo}
          className="w-9 h-9 rounded-lg hover:bg-vp-rail disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors text-vp-ink/70 hover:text-vp-ink"
        >
          <Redo2 className="w-4 h-4" strokeWidth={ICON_STROKE} />
        </button>
      </div>

      {/* Right cluster: mobile-only undo/redo, then preview + Next */}
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        <button
          aria-label="Undo"
          onClick={() => history.undo()}
          disabled={!canUndo}
          className="md:hidden w-9 h-9 rounded-lg hover:bg-vp-rail disabled:opacity-30 flex items-center justify-center text-vp-ink/70"
        >
          <Undo2 className="w-4 h-4" strokeWidth={ICON_STROKE} />
        </button>
        <button
          aria-label="Redo"
          onClick={() => history.redo()}
          disabled={!canRedo}
          className="md:hidden w-9 h-9 rounded-lg hover:bg-vp-rail disabled:opacity-30 flex items-center justify-center text-vp-ink/70"
        >
          <Redo2 className="w-4 h-4" strokeWidth={ICON_STROKE} />
        </button>
        {/* Preview — opens a full-screen 3D-flip preview modal with the
            material texture overlay + shape clip-path applied. */}
        <button
          aria-label="Open Preview"
          onClick={() => setPreviewFlipOpen(true)}
          className="hidden sm:flex h-9 items-center gap-1.5 px-3 rounded-full text-[12px] font-semibold tracking-wide text-vp-ink/70 hover:bg-vp-rail hover:text-vp-ink transition-all"
        >
          <Eye className="w-4 h-4" strokeWidth={ICON_STROKE} />
          <span>Preview</span>
        </button>
        <button
          onClick={() => setPreviewOpen(true)}
          className="h-9 px-4 sm:px-6 rounded-full bg-vp-blue hover:bg-vp-blue-hover text-white text-[13px] font-semibold tracking-wide shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0"
        >
          Next
        </button>
      </div>
    </header>
  );
}
