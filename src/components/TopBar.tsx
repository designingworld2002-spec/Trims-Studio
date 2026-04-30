import { Cloud, Eye, Redo2, Undo2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { history } from "./Workspace";
import { StudioLogo } from "./StudioLogo";

export function TopBar() {
  const productTitle = useCanvasStore((s) => s.productTitle);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const lastSavedAt = useCanvasStore((s) => s.lastSavedAt);
  const setPreviewOpen = useCanvasStore((s) => s.setPreviewOpen);

  return (
    <header className="h-14 bg-white border-b border-vp-border flex items-center px-2 sm:px-3 shrink-0 gap-1">
      {/* Logo — animated rolling sewing-button. Text label hides on small screens. */}
      <div className="flex items-center gap-2 sm:pr-4 sm:border-r sm:border-vp-border shrink-0">
        <StudioLogo size={32} />
        <span className="font-semibold text-sm hidden sm:inline">
          trims.in studio
        </span>
      </div>

      {/* Product title */}
      <div className="px-2 sm:px-4 text-sm text-vp-ink/80 truncate min-w-0 flex-1 md:flex-initial">
        {productTitle}
      </div>

      {/* Center: auto-save + undo/redo. Hidden on mobile to free up space;
          undo/redo move to the right cluster instead. */}
      <div className="hidden md:flex flex-1 items-center justify-center gap-1">
        <div className="flex items-center gap-1.5 text-xs text-vp-muted px-3">
          <Cloud className="w-4 h-4" />
          <span>{lastSavedAt ? "Saved" : "Not saved yet"}</span>
        </div>
        <button
          aria-label="Undo"
          onClick={() => history.undo()}
          disabled={!canUndo}
          className="w-9 h-9 rounded-md hover:bg-vp-rail disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          aria-label="Redo"
          onClick={() => history.redo()}
          disabled={!canRedo}
          className="w-9 h-9 rounded-md hover:bg-vp-rail disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center"
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      {/* Right cluster: mobile-only undo/redo, then preview + Next */}
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        <button
          aria-label="Undo"
          onClick={() => history.undo()}
          disabled={!canUndo}
          className="md:hidden w-9 h-9 rounded-md hover:bg-vp-rail disabled:opacity-30 flex items-center justify-center"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          aria-label="Redo"
          onClick={() => history.redo()}
          disabled={!canRedo}
          className="md:hidden w-9 h-9 rounded-md hover:bg-vp-rail disabled:opacity-30 flex items-center justify-center"
        >
          <Redo2 className="w-4 h-4" />
        </button>
        <button
          aria-label="Preview"
          onClick={() => setPreviewOpen(true)}
          className="hidden sm:flex w-9 h-9 rounded-md hover:bg-vp-rail items-center justify-center"
        >
          <Eye className="w-4 h-4" />
        </button>
        <button
          onClick={() => setPreviewOpen(true)}
          className="h-9 px-3 sm:px-5 rounded-md bg-vp-blue hover:bg-vp-blue-hover text-white text-sm font-medium"
        >
          Next
        </button>
      </div>
    </header>
  );
}
