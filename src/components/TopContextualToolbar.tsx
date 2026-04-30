import { useState, useRef, useEffect } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Italic,
  Sliders,
  Sparkles,
  Underline,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";

const FONTS = [
  "Arimo",
  "Inter",
  "Roboto",
  "Helvetica",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Comic Sans MS",
];

/**
 * Top contextual toolbar — anchored to the top of the canvas viewport.
 *
 * Renders nothing when no object is selected. For text we render the rich
 * text controls; for shapes/images a slimmer fill+opacity bar.
 */
export function TopContextualToolbar() {
  const selected = useCanvasStore((s) => s.selected);
  const patch = useCanvasStore((s) => s.patchActive);

  if (!selected) return null;

  return (
    <div
      role="toolbar"
      aria-label="Element toolbar"
      className="absolute top-3 left-1/2 -translate-x-1/2 bg-white rounded-md shadow-vp-pop border border-vp-border h-11 flex items-center gap-1 px-2 z-20"
    >
      {selected.type === "text" ? (
        <TextControls selected={selected} patch={patch} />
      ) : (
        <ObjectControls selected={selected} patch={patch} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TextControls({
  selected,
  patch,
}: {
  selected: NonNullable<ReturnType<typeof useCanvasStore.getState>["selected"]>;
  patch: ReturnType<typeof useCanvasStore.getState>["patchActive"];
}) {
  return (
    <>
      {/* Font family */}
      <Dropdown
        label={selected.fontFamily}
        width="w-44"
        items={FONTS.map((f) => ({ label: f, value: f }))}
        onSelect={(v) => patch({ fontFamily: v })}
      />

      <Divider />

      {/* Font size */}
      <input
        type="number"
        min={8}
        max={200}
        value={Number(selected.fontSize || 20)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n > 0) patch({ fontSize: n });
        }}
        className="w-14 h-7 px-2 text-sm rounded border border-vp-border focus:outline-none focus:border-vp-blue"
      />

      <Divider />

      {/* Color */}
      <ColorButton
        value={selected.fill || "#000000"}
        onChange={(c) => patch({ fill: c })}
      />

      <Divider />

      {/* Bold */}
      <IconToggle
        active={selected.fontWeight === "bold"}
        onClick={() =>
          patch({
            fontWeight: selected.fontWeight === "bold" ? "normal" : "bold",
          })
        }
        icon={Bold}
        label="Bold"
      />

      {/* Italic */}
      <IconToggle
        active={selected.fontStyle === "italic"}
        onClick={() =>
          patch({
            fontStyle: selected.fontStyle === "italic" ? "normal" : "italic",
          })
        }
        icon={Italic}
        label="Italic"
      />

      {/* Underline (display-only — fabric supports via .underline; we'd extend the store) */}
      <IconToggle
        active={false}
        onClick={() => {}}
        icon={Underline}
        label="Underline"
      />

      <Divider />

      {/* Alignment */}
      <Popover
        trigger={
          <button
            aria-label="Alignment"
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center"
          >
            <AlignmentIcon align={selected.textAlign} />
          </button>
        }
      >
        <div className="flex gap-1 p-1">
          {(["left", "center", "right", "justify"] as const).map((a) => (
            <button
              key={a}
              aria-label={`Align ${a}`}
              onClick={() => patch({ textAlign: a })}
              className={[
                "w-8 h-8 rounded flex items-center justify-center",
                selected.textAlign === a
                  ? "bg-vp-blue-light text-vp-blue"
                  : "hover:bg-vp-rail",
              ].join(" ")}
            >
              <AlignmentIcon align={a} />
            </button>
          ))}
        </div>
      </Popover>

      <Divider />

      {/* Effects popover (Shadow / Highlight / Glitch / Echo / Curve) */}
      <EffectsPopover selected={selected} patch={patch} />

      <Divider />

      {/* Advanced popover (opacity, rotation, line height, char spacing) */}
      <Popover
        trigger={
          <button
            aria-label="Advanced"
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center"
          >
            <Sliders className="w-4 h-4" />
          </button>
        }
      >
        <div className="w-60 p-3 space-y-3">
          <Slider
            label="Opacity"
            min={0}
            max={1}
            step={0.01}
            value={Number(selected.opacity || 1)}
            onChange={(v) => patch({ opacity: v })}
            display={`${Math.round(Number(selected.opacity || 1) * 100)}%`}
          />
          <Slider
            label="Rotation"
            min={0}
            max={360}
            step={1}
            value={Number(selected.angle || 0)}
            onChange={(v) => patch({ angle: v })}
            display={`${Math.round(Number(selected.angle || 0))}°`}
          />
          <Slider
            label="Line height"
            min={0.8}
            max={3}
            step={0.05}
            value={Number(selected.lineHeight || 1.16)}
            onChange={(v) => patch({ lineHeight: v })}
            display={Number(selected.lineHeight || 1.16).toFixed(2)}
          />
          <Slider
            label="Letter spacing"
            min={-200}
            max={800}
            step={10}
            value={Number(selected.charSpacing || 0)}
            onChange={(v) => patch({ charSpacing: v })}
            display={String(Math.round(Number(selected.charSpacing || 0)))}
          />
        </div>
      </Popover>
    </>
  );
}

function ObjectControls({
  selected,
  patch,
}: {
  selected: NonNullable<ReturnType<typeof useCanvasStore.getState>["selected"]>;
  patch: ReturnType<typeof useCanvasStore.getState>["patchActive"];
}) {
  return (
    <>
      <ColorButton
        value={selected.fill || "#000000"}
        onChange={(c) => patch({ fill: c })}
      />
      <Divider />
      <EffectsPopover selected={selected} patch={patch} />
      <Divider />
      <Popover
        trigger={
          <button
            aria-label="Advanced"
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center"
          >
            <Sliders className="w-4 h-4" />
          </button>
        }
      >
        <div className="w-60 p-3 space-y-3">
          <Slider
            label="Opacity"
            min={0}
            max={1}
            step={0.01}
            value={Number(selected.opacity || 1)}
            onChange={(v) => patch({ opacity: v })}
            display={`${Math.round(Number(selected.opacity || 1) * 100)}%`}
          />
          <Slider
            label="Rotation"
            min={0}
            max={360}
            step={1}
            value={Number(selected.angle || 0)}
            onChange={(v) => patch({ angle: v })}
            display={`${Math.round(Number(selected.angle || 0))}°`}
          />
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Effects popover                                                     */
/* ------------------------------------------------------------------ */

function EffectsPopover({
  selected,
  patch,
}: {
  selected: NonNullable<ReturnType<typeof useCanvasStore.getState>["selected"]>;
  patch: ReturnType<typeof useCanvasStore.getState>["patchActive"];
}) {
  // All visual effects are intentionally disabled in the current build —
  // they're staged for Phase 3 once the print pipeline can flatten them
  // safely (shadows in particular don't survive a PDF/X-1a export reliably).
  const styles = [
    {
      key: "original",
      label: "Original",
      active: true,
      apply: () => {},
    },
    { key: "shadow", label: "Shadow", active: false, disabled: true },
    { key: "highlight", label: "Highlight", active: false, disabled: true },
    { key: "glitch", label: "Glitch", active: false, disabled: true },
    { key: "echo", label: "Echo", active: false, disabled: true },
  ];

  return (
    <Popover
      trigger={
        <button
          aria-label="Effects"
          className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center"
        >
          <Sparkles className="w-4 h-4" />
        </button>
      }
    >
      <div className="w-64 p-3 space-y-3">
        <div>
          <div className="text-xs font-semibold mb-2">Style</div>
          <div className="grid grid-cols-3 gap-1.5">
            {styles.map((s) => (
              <button
                key={s.key}
                disabled={s.disabled}
                onClick={s.apply}
                className={[
                  "h-9 rounded border text-xs font-medium",
                  s.active
                    ? "border-vp-blue bg-vp-blue-light text-vp-blue"
                    : "border-vp-border hover:border-vp-blue text-vp-ink",
                  s.disabled ? "opacity-40 cursor-not-allowed hover:border-vp-border" : "",
                ].join(" ")}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold mb-2">Shape</div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              className="h-9 rounded border border-vp-blue bg-vp-blue-light text-vp-blue text-xs font-medium"
              onClick={() => {}}
            >
              None
            </button>
            <button
              disabled
              className="h-9 rounded border border-vp-border text-xs font-medium opacity-40 cursor-not-allowed"
            >
              Curve
            </button>
          </div>
        </div>
      </div>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

function Divider() {
  return <div className="w-px h-5 bg-vp-border mx-0.5" />;
}

function IconToggle({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={[
        "w-8 h-8 rounded flex items-center justify-center",
        active ? "bg-vp-blue-light text-vp-blue" : "hover:bg-vp-rail",
      ].join(" ")}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

function AlignmentIcon({ align }: { align: string }) {
  const I =
    align === "center"
      ? AlignCenter
      : align === "right"
        ? AlignRight
        : align === "justify"
          ? AlignJustify
          : AlignLeft;
  return <I className="w-4 h-4" />;
}

function ColorButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <label
      className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center cursor-pointer"
      title="Color"
    >
      <span
        className="w-5 h-5 rounded-full border border-vp-border"
        style={{ background: value }}
      />
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
    </label>
  );
}

function Dropdown({
  label,
  items,
  onSelect,
  width = "w-40",
}: {
  label: string;
  items: { label: string; value: string }[];
  onSelect: (v: string) => void;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          className={`${width} h-7 px-2 rounded border border-vp-border text-sm flex items-center justify-between hover:border-vp-blue`}
        >
          <span className="truncate text-left">{label}</span>
          <ChevronDown className="w-3.5 h-3.5 text-vp-muted ml-1" />
        </button>
      }
    >
      <div className={`${width} max-h-60 overflow-y-auto vp-scroll py-1`}>
        {items.map((i) => (
          <button
            key={i.value}
            onClick={() => {
              onSelect(i.value);
              setOpen(false);
            }}
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-vp-rail"
            style={{ fontFamily: i.value }}
          >
            {i.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  display,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  display: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium">{label}</span>
        <span className="text-vp-muted">{display}</span>
      </div>
      <input
        type="range"
        className="vp-range w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Popover({
  trigger,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (b: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlledOpen ?? uncontrolled;
  const setOpen = (b: boolean) => {
    onOpenChange ? onOpenChange(b) : setUncontrolled(b);
  };
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white rounded-md shadow-vp-pop border border-vp-border z-30">
          {children}
        </div>
      )}
    </div>
  );
}
