import { Minus, Plus, Settings } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";

export function BottomBar() {
  const zoom = useCanvasStore((s) => s.zoom);
  const setZoom = useCanvasStore((s) => s.setZoom);

  const stepDown = () => setZoom(Math.max(0.25, +(zoom - 0.1).toFixed(2)));
  const stepUp = () => setZoom(Math.min(4, +(zoom + 0.1).toFixed(2)));
  const reset = () => setZoom(1);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white rounded-full shadow-vp-pop border border-vp-border h-10 flex items-center px-1 gap-0.5 z-10">
      <button
        aria-label="Zoom out"
        onClick={stepDown}
        className="w-8 h-8 rounded-full hover:bg-vp-rail flex items-center justify-center"
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        onClick={reset}
        className="min-w-14 px-2 h-8 rounded-full hover:bg-vp-rail text-xs font-medium"
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        aria-label="Zoom in"
        onClick={stepUp}
        className="w-8 h-8 rounded-full hover:bg-vp-rail flex items-center justify-center"
      >
        <Plus className="w-4 h-4" />
      </button>
      <div className="w-px h-5 bg-vp-border mx-1" />
      <button
        aria-label="Settings"
        className="w-8 h-8 rounded-full hover:bg-vp-rail flex items-center justify-center"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
