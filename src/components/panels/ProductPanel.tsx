import { Link2, Link2Off } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import type { CanvasShape } from "@/store/canvasStore";
import { RecentDesignsSection } from "./RecentDesignsSection";

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
  const toggleOrientation = useCanvasStore((s) => s.toggleOrientation);
  const productHandle = useCanvasStore((s) => s.productConfig.handle);
  const mode = useCanvasStore((s) => s.mode);

  const isHorizontal = lengthMm >= widthMm;
  // Template mode hides the unlink button entirely; upload mode shows it.
  const showLinkToggle = mode !== "template";

  // Per-product orientation rules:
  //   - hang-tags:   removed from sidebar entirely (use the floating
  //                  rotate button on the canvas instead).
  //   - woven-labels: shown but DISABLED (looms can't switch orientation
  //                  on the fly — the orientation is set by the loom).
  //   - anything else: shown and interactive.
  const showOrientation = productHandle !== "hang-tags";
  const orientationDisabled = productHandle === "woven-labels";

  return (
    <div className="space-y-7">
      <div>
        <h3 className="text-[15px] font-semibold mb-1.5 tracking-tight text-vp-ink">
          Product options
        </h3>
        <p className="text-[12px] text-vp-muted leading-relaxed">
          The design adjusts to your selected options.
        </p>
      </div>

      {/* Orientation — per-product behaviour. Hang tags hide this
          entirely (floating canvas rotate button takes over). Woven
          labels show but disable. */}
      {showOrientation && (
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 mb-2.5">
            Product orientation
            {orientationDisabled && (
              <span className="normal-case font-medium tracking-normal text-slate-400">
                {" "}
                (fixed by loom)
              </span>
            )}
          </label>
          <div
            className={[
              "flex rounded-md border border-vp-border overflow-hidden select-none",
              orientationDisabled ? "opacity-50 pointer-events-none" : "",
            ].join(" ")}
            role="group"
            aria-label="Orientation"
            aria-disabled={orientationDisabled}
          >
            <button
              type="button"
              onClick={() => {
                if (!isHorizontal && !orientationDisabled) toggleOrientation();
              }}
              aria-pressed={isHorizontal}
              className={[
                "flex-1 h-9 text-sm flex items-center justify-center transition-colors",
                isHorizontal
                  ? "bg-vp-blue-light text-vp-blue font-semibold"
                  : "bg-white text-vp-ink/70 hover:bg-vp-rail",
              ].join(" ")}
            >
              Landscape
            </button>
            <button
              type="button"
              onClick={() => {
                if (isHorizontal && !orientationDisabled) toggleOrientation();
              }}
              aria-pressed={!isHorizontal}
              className={[
                "flex-1 h-9 text-sm flex items-center justify-center border-l border-vp-border transition-colors",
                !isHorizontal
                  ? "bg-vp-blue-light text-vp-blue font-semibold"
                  : "bg-white text-vp-ink/70 hover:bg-vp-rail",
              ].join(" ")}
            >
              Portrait
            </button>
          </div>
        </div>
      )}

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

      {/* Preset sizes — derived from the current aspect ratio so the
          design never distorts when a preset is clicked. */}
      <SizePresets
        lengthMm={lengthMm}
        widthMm={widthMm}
        onPick={(l, w) => {
          // Use setCanvasSize directly to update BOTH axes atomically.
          // updateLength/updateWidth go through the aspect-lock logic
          // which would round differently; presets carry their own
          // aspect-preserving math.
          useCanvasStore.getState().setCanvasSize(l, w);
        }}
      />

      {/* Dynamic Shape Selection — currently surfaced for Hangtags but
          works for any product. Live modifier sliders give exact mm
          control over corner rounding / chamfer length. */}
      <ShapeSelection />

      {/* Logged-in user's saved designs (hidden when anonymous). */}
      <RecentDesignsSection />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shape selection + dynamic modifier sliders                          */
/* ------------------------------------------------------------------ */

interface ShapeTile {
  key: CanvasShape;
  label: string;
  icon: (active: boolean) => JSX.Element;
}

const SHAPES: ShapeTile[] = [
  {
    key: "rectangle",
    label: "Rectangle",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <rect
          x="6" y="6" width="20" height="20" rx="1"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "round-corners",
    label: "Rounded",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <rect
          x="6" y="6" width="20" height="20" rx="5"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "cut-corners",
    label: "Cut corners",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <polygon
          points="10,6 22,6 26,10 26,22 22,26 10,26 6,22 6,10"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "oval",
    label: "Oval",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <ellipse
          cx="16" cy="16" rx="10" ry="10"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "star",
    label: "Star",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <polygon
          points="16,5 19,13 27,13 21,18 23,26 16,21 9,26 11,18 5,13 13,13"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  // ---- Premium hangtag silhouettes ----
  {
    key: "scalloped",
    label: "Scalloped",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <path
          d="M 11 6 L 21 6 A 5 5 0 0 0 26 11 L 26 21 A 5 5 0 0 0 21 26 L 11 26 A 5 5 0 0 0 6 21 L 6 11 A 5 5 0 0 0 11 6 Z"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "pointed-top",
    label: "Pointed top",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <polygon
          points="16,5 26,12 26,27 6,27 6,12"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "hexagon-pointed",
    label: "Hex point",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <polygon
          points="16,4 26,11 26,21 16,28 6,21 6,11"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "flared",
    label: "Flared",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <path
          d="M 6 6 L 26 6 Q 22 16 26 26 L 6 26 Q 10 16 6 6 Z"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
  {
    key: "mixed-cut-round",
    label: "Cut + round",
    icon: (a) => (
      <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden>
        <path
          d="M 11 6 L 21 6 L 26 11 L 26 21 A 5 5 0 0 1 21 26 L 11 26 A 5 5 0 0 1 6 21 L 6 11 L 11 6 Z"
          fill="none" stroke={a ? "currentColor" : "#94a3b8"} strokeWidth="1.6"
        />
      </svg>
    ),
  },
];

function ShapeSelection() {
  const shape = useCanvasStore((s) => s.canvasShape);
  const setShape = useCanvasStore((s) => s.setCanvasShape);
  const modifiers = useCanvasStore((s) => s.shapeModifiers);
  const updateModifiers = useCanvasStore((s) => s.updateShapeModifiers);
  const allowedShapes = useCanvasStore((s) => s.productConfig.allowedShapes);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);

  // Single-shape products (e.g. woven labels) hide the picker entirely —
  // the choice is fixed by the manufacturing process.
  if (allowedShapes.length <= 1) return null;

  const visibleShapes = SHAPES.filter((t) => allowedShapes.includes(t.key));

  const shortEdge = Math.min(lengthMm, widthMm);
  const maxModifier = Math.max(1, Math.round(shortEdge * 0.4));

  // Pre-clamp current values so the readout never shows "12 mm" while
  // the engine is rendering an 8 mm chamfer (40% clamp).
  const radius = Math.min(modifiers.cornerRadiusMm, maxModifier);
  const slant = Math.min(modifiers.slantLengthMm, maxModifier);

  const supportsCornersMode =
    shape === "round-corners" || shape === "cut-corners";

  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 mb-2.5">
        Shape
      </label>

      <div
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${visibleShapes.length}, minmax(0, 1fr))`,
        }}
      >
        {visibleShapes.map((t) => {
          const active = shape === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setShape(t.key)}
              aria-pressed={active}
              title={t.label}
              className={[
                "h-14 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-all",
                active
                  ? "border-vp-accent bg-vp-accent/5 text-vp-accent shadow-sm"
                  : "border-vp-border text-slate-500 hover:border-slate-400 hover:text-vp-ink",
              ].join(" ")}
            >
              {t.icon(active)}
              <span className="text-[9px] font-medium leading-none">
                {t.label.split(" ")[0]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Conditional sliders. */}
      {shape === "round-corners" && (
        <ModifierSlider
          label="Corner rounding"
          value={radius}
          max={maxModifier}
          onChange={(v) => updateModifiers({ cornerRadiusMm: v })}
        />
      )}
      {shape === "cut-corners" && (
        <ModifierSlider
          label="Slant length"
          value={slant}
          max={maxModifier}
          onChange={(v) => updateModifiers({ slantLengthMm: v })}
        />
      )}
      {shape === "star" && (
        <ModifierSlider
          label="Number of points"
          value={modifiers.starPoints}
          min={5}
          max={12}
          step={1}
          suffix=""
          onChange={(v) => updateModifiers({ starPoints: v })}
        />
      )}
      {shape === "scalloped" && (
        <ModifierSlider
          label="Scallop radius"
          value={radius}
          max={maxModifier}
          onChange={(v) => updateModifiers({ cornerRadiusMm: v })}
        />
      )}
      {(shape === "pointed-top" || shape === "hexagon-pointed") && (
        <ModifierSlider
          label="Point height"
          value={slant}
          max={maxModifier}
          onChange={(v) => updateModifiers({ slantLengthMm: v })}
        />
      )}
      {shape === "flared" && (
        <ModifierSlider
          label="Waist depth"
          value={slant}
          max={maxModifier}
          onChange={(v) => updateModifiers({ slantLengthMm: v })}
        />
      )}
      {shape === "mixed-cut-round" && (
        <ModifierSlider
          label="Corner size"
          value={slant}
          max={maxModifier}
          // Drive both the top slant AND the bottom corner radius from a
          // single slider so the silhouette stays balanced.
          onChange={(v) =>
            updateModifiers({ slantLengthMm: v, cornerRadiusMm: v })
          }
        />
      )}

      {/* "Top corners" / "All corners" segmented control — only meaningful
          for round + cut. Standard luggage-tag profile is top-only. */}
      {supportsCornersMode && (
        <CornersModeToggle
          value={modifiers.cornersMode}
          onChange={(v) => updateModifiers({ cornersMode: v })}
        />
      )}
    </div>
  );
}

function CornersModeToggle({
  value,
  onChange,
}: {
  value: "top" | "all";
  onChange: (v: "top" | "all") => void;
}) {
  const opts: { key: "top" | "all"; label: string }[] = [
    { key: "top", label: "Top corners" },
    { key: "all", label: "All corners" },
  ];
  return (
    <div className="mt-4">
      <div className="text-[11px] font-medium text-vp-ink mb-1.5">
        Apply to
      </div>
      <div
        className="flex rounded-full bg-slate-100 p-0.5"
        role="group"
        aria-label="Corners mode"
      >
        {opts.map((o) => {
          const active = value === o.key;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onChange(o.key)}
              aria-pressed={active}
              className={[
                "flex-1 h-8 rounded-full text-[11.5px] font-semibold transition-all",
                active
                  ? "bg-white text-vp-accent shadow-sm"
                  : "text-vp-muted hover:text-vp-ink",
              ].join(" ")}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModifierSlider({
  label,
  value,
  min = 0,
  max,
  step = 1,
  suffix = " mm",
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-vp-ink">{label}</span>
        <span className="text-[11px] font-semibold tabular-nums text-vp-accent">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="vp-range w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      <div className="flex items-center justify-between mt-1 text-[10px] text-vp-muted">
        <span>{min}{suffix}</span>
        <span>{max}{suffix}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Size preset pills                                                   */
/* ------------------------------------------------------------------ */

/**
 * Generate four standardised sizes for the active aspect ratio.
 *
 * We anchor on the SHORT edge (the "width" in our naming) at fixed
 * tiers — 20, 35, 50, 70 mm — then derive the long edge by multiplying
 * by the live aspect ratio. That way every preset preserves the exact
 * template ratio (so picking one never distorts a loaded design) AND
 * the numbers stay sensible across orientations.
 */
const PRESET_WIDTHS_MM = [
  { label: "Small", widthMm: 20 },
  { label: "Standard", widthMm: 35 },
  { label: "Medium", widthMm: 50 },
  { label: "Large", widthMm: 70 },
];

function SizePresets({
  lengthMm,
  widthMm,
  onPick,
}: {
  lengthMm: number;
  widthMm: number;
  onPick: (lengthMm: number, widthMm: number) => void;
}) {
  // Live aspect ratio of the current workspace = active template's
  // ratio (since each load syncs canvasLengthMm/widthMm to the
  // saved design's dimensions). Long-edge orientation preserved.
  const ratio = widthMm > 0 ? lengthMm / widthMm : 1;
  const presets = PRESET_WIDTHS_MM.map((p) => {
    const newWidth = p.widthMm;
    const newLength = Math.max(10, Math.round(newWidth * ratio));
    return { label: p.label, length: newLength, width: newWidth };
  });
  return (
    <div>
      <label className="block text-xs font-medium mb-2">
        Preset sizes
        <span className="ml-1 text-vp-muted font-normal">
          (keeps the current ratio)
        </span>
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        {presets.map((p) => {
          const active = lengthMm === p.length && widthMm === p.width;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onPick(p.length, p.width)}
              className={[
                "h-12 rounded-md border text-left px-3 transition-colors",
                active
                  ? "border-vp-blue bg-vp-blue-light text-vp-blue"
                  : "border-vp-border hover:border-vp-blue text-vp-ink",
              ].join(" ")}
              title={`${p.length} × ${p.width} mm`}
            >
              <div className="text-xs font-semibold">{p.label}</div>
              <div className="text-[10px] text-vp-muted">
                {p.length} × {p.width} mm
              </div>
            </button>
          );
        })}
      </div>
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
      <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 mb-2">
        {label}
      </span>
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
        className="w-full h-10 px-3.5 rounded-lg border border-vp-border text-[13px] font-medium tabular-nums focus:outline-none focus:border-vp-blue focus:ring-2 focus:ring-vp-blue/15 transition"
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
