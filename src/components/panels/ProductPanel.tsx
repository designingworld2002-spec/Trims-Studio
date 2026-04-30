import { Link2, Link2Off } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";

/**
 * Product Options panel.
 *
 * Behaviour rules:
 *
 *  - Orientation toggle is read-only (visible, dimmed). The studio derives
 *    orientation from the current dimensions; users change it implicitly by
 *    swapping length/width.
 *
 *  - Aspect-ratio lock:
 *      • Template mode  → strictly locked. No chain icon.
 *      • Upload mode    → locked by default, with a chain icon between the
 *        two inputs the user can click to break/restore the link.
 *
 *  - Math.round() everywhere so input boxes never show long decimals.
 *
 *  - Dimension changes flow through `updateLength` / `updateWidth` in the
 *    store, which respect the lock state and trigger the existing guide
 *    redraw effect in Workspace via the `canvasLengthMm`/`canvasWidthMm`
 *    subscription.
 */
export function ProductPanel() {
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const isLocked = useCanvasStore((s) => s.isAspectRatioLocked);
  const setLocked = useCanvasStore((s) => s.setAspectRatioLocked);
  const updateLength = useCanvasStore((s) => s.updateLength);
  const updateWidth = useCanvasStore((s) => s.updateWidth);
  const mode = useCanvasStore((s) => s.mode);

  const isHorizontal = lengthMm >= widthMm;
  // Template mode hides the unlink button entirely; upload mode shows it.
  const showLinkToggle = mode !== "template";

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-1">Product options</h3>
        <p className="text-xs text-vp-muted">
          The design adjusts to your selected options.
        </p>
      </div>

      {/* Orientation: visible, read-only */}
      <div>
        <label className="block text-xs font-medium mb-2">
          Product orientation{" "}
          <span className="text-vp-muted font-normal">(view only)</span>
        </label>
        <div
          className="flex rounded-md border border-vp-border overflow-hidden opacity-60 pointer-events-none select-none"
          aria-disabled="true"
        >
          <div
            className={[
              "flex-1 h-9 text-sm flex items-center justify-center",
              isHorizontal ? "bg-vp-blue-light text-vp-blue font-medium" : "bg-white",
            ].join(" ")}
          >
            Horizontal
          </div>
          <div
            className={[
              "flex-1 h-9 text-sm flex items-center justify-center border-l border-vp-border",
              !isHorizontal ? "bg-vp-blue-light text-vp-blue font-medium" : "bg-white",
            ].join(" ")}
          >
            Vertical
          </div>
        </div>
      </div>

      {/* Length / Width with optional chain link */}
      <div className="flex items-end gap-2">
        <NumField
          label="Length (mm)"
          value={lengthMm}
          onChange={updateLength}
        />
        {showLinkToggle && (
          <ChainButton
            isLocked={isLocked}
            onToggle={() => setLocked(!isLocked)}
          />
        )}
        {!showLinkToggle && (
          // Template mode: keep the same horizontal rhythm with a spacer +
          // a static lock-confirm icon so users see why the fields are tied.
          <div
            className="h-9 w-9 mb-px rounded-md flex items-center justify-center text-vp-muted"
            title="Locked to template aspect ratio"
            aria-hidden="true"
          >
            <Link2 className="w-4 h-4" />
          </div>
        )}
        <NumField
          label="Width (mm)"
          value={widthMm}
          onChange={updateWidth}
        />
      </div>

      <p className="text-[11px] text-vp-muted">
        Length is the long edge of the product, width is the short edge.
        {isLocked
          ? " Dimensions are linked — changing one updates the other."
          : " Dimensions are independent."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block flex-1">
      <span className="block text-xs font-medium mb-1">{label}</span>
      <input
        type="number"
        min={10}
        max={300}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n > 0) onChange(Math.round(n));
        }}
        className="w-full h-9 px-3 rounded-md border border-vp-border text-sm focus:outline-none focus:border-vp-blue"
      />
    </label>
  );
}

function ChainButton({
  isLocked,
  onToggle,
}: {
  isLocked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isLocked}
      title={
        isLocked
          ? "Aspect ratio locked — click to unlink"
          : "Aspect ratio unlocked — click to link"
      }
      className={[
        "h-9 w-9 mb-px rounded-md border flex items-center justify-center transition-colors",
        isLocked
          ? "border-vp-blue text-vp-blue bg-vp-blue-light"
          : "border-vp-border text-vp-muted hover:border-vp-blue",
      ].join(" ")}
    >
      {isLocked ? (
        <Link2 className="w-4 h-4" />
      ) : (
        <Link2Off className="w-4 h-4" />
      )}
    </button>
  );
}
