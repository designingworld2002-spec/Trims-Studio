import { Eye, EyeOff, Minus, Plus, Settings, Trash2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { SmartPopover } from "./SmartPopover";
import { designOps } from "./Workspace";

export function BottomBar() {
  const zoom = useCanvasStore((s) => s.zoom);
  const setZoom = useCanvasStore((s) => s.setZoom);
  const showGuides = useCanvasStore((s) => s.showGuides);
  const setShowGuides = useCanvasStore((s) => s.setShowGuides);

  const stepDown = () => setZoom(Math.max(0.25, +(zoom - 0.1).toFixed(2)));
  const stepUp = () => setZoom(Math.min(4, +(zoom + 0.1).toFixed(2)));
  const reset = () => setZoom(1);

  const clearCanvas = () => {
    if (
      window.confirm(
        "Remove every text, image, and shape from the canvas? This can't be undone except via Undo (Ctrl/Cmd+Z)."
      )
    ) {
      designOps.clearAll();
    }
  };

  return (
    <div className="absolute top-1/2 -translate-y-1/2 right-4 bg-white rounded-full shadow-vp-pop border border-vp-border w-10 flex flex-col items-center py-1 gap-0.5 z-10">
      <button
        aria-label="Zoom in"
        onClick={stepUp}
        className="w-8 h-8 rounded-full hover:bg-vp-rail flex items-center justify-center"
      >
        <Plus className="w-4 h-4" />
      </button>
      <button
        onClick={reset}
        className="min-w-8 px-1 h-8 rounded-full hover:bg-vp-rail text-[10px] font-medium leading-none"
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        aria-label="Zoom out"
        onClick={stepDown}
        className="w-8 h-8 rounded-full hover:bg-vp-rail flex items-center justify-center"
      >
        <Minus className="w-4 h-4" />
      </button>
      <div className="h-px w-5 bg-vp-border my-1" />
      <SmartPopover
        side="left"
        align="center"
        className="w-60 p-2"
        trigger={
          <button
            aria-label="Canvas settings"
            className="w-8 h-8 rounded-full hover:bg-vp-rail flex items-center justify-center"
          >
            <Settings className="w-4 h-4" />
          </button>
        }
      >
        <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-vp-muted font-semibold">
          Canvas settings
        </div>
        <ToggleRow
          label="Show bleed / safe guides"
          checked={showGuides}
          onChange={setShowGuides}
          icon={showGuides ? Eye : EyeOff}
        />
        <ToggleRow
          label="Snap to grid"
          checked={false}
          onChange={() => {}}
          disabled
          hint="Coming soon"
        />
        <div className="border-t border-vp-border mt-1 pt-1">
          <button
            onClick={clearCanvas}
            className="w-full px-3 py-2 text-sm text-left flex items-center gap-2 rounded hover:bg-red-50 text-red-600"
          >
            <Trash2 className="w-4 h-4" />
            Clear canvas
          </button>
        </div>
      </SmartPopover>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  icon: Icon,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
  icon?: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={[
        "w-full px-3 py-2 text-sm text-left flex items-center gap-2 rounded",
        disabled
          ? "text-vp-muted cursor-not-allowed"
          : "text-vp-ink hover:bg-vp-rail",
      ].join(" ")}
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" />}
      <span className="flex-1">{label}</span>
      {hint ? (
        <span className="text-[10px] uppercase text-vp-muted">{hint}</span>
      ) : (
        <span
          className={[
            "w-8 h-5 rounded-full relative transition-colors",
            checked ? "bg-vp-blue" : "bg-vp-border",
          ].join(" ")}
        >
          <span
            className={[
              "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
              checked ? "translate-x-3.5" : "translate-x-0.5",
            ].join(" ")}
          />
        </span>
      )}
    </button>
  );
}
