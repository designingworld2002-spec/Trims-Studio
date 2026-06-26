import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CaseSensitive,
  Italic,
  List,
  Sliders,
  Sparkles,
  Underline,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { SmartPopover } from "./SmartPopover";
import { FontCombobox } from "./FontCombobox";

/**
 * Top contextual toolbar — anchored to the top of the canvas viewport.
 *
 * Renders nothing when no object is selected. Two variants:
 *   - text controls (font / size / color / bold / italic / align / effects / advanced)
 *   - object controls (color / stroke width / effects / advanced)
 *
 * Mobile: the bar can be wider than the viewport, so we cap its width at
 * `calc(100vw - 24px)` and let it scroll horizontally instead of clipping.
 * All popovers are portal-rendered (`SmartPopover`) so they're never
 * clipped by parent overflow.
 */
export function TopContextualToolbar() {
  const selected = useCanvasStore((s) => s.selected);
  const patch = useCanvasStore((s) => s.patchActive);

  if (!selected) return null;

  // Union quality flag — low DPI OR optical blur. Drives the red banner
  // below the toolbar. (The pulsing warning badge now lives centred over
  // the image itself — see Workspace.tsx — not on the toolbar.)
  const imageFlagged =
    selected.type === "image" && (selected.isLowRes || selected.isBlurry);

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 max-w-[calc(100vw-24px)]">
      <div
        role="toolbar"
        aria-label="Element toolbar"
        className="relative bg-white rounded-md shadow-vp-pop border border-vp-border h-11 flex items-center gap-1 px-2 overflow-visible w-max max-w-full"
      >
        {selected.type === "text" ? (
          <TextControls selected={selected} patch={patch} />
        ) : selected.type === "qr" ? (
          <QrControls selected={selected} />
        ) : selected.type === "barcode" ? (
          <BarcodeControls selected={selected} />
        ) : (
          <ObjectControls selected={selected} patch={patch} />
        )}
      </div>
      {imageFlagged && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-800 rounded-md px-3 py-2 shadow-sm w-max max-w-full">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span className="text-[12.5px] font-medium leading-snug">
            Low-quality image — may print blurry.
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* QR-specific controls                                                */
/* ------------------------------------------------------------------ */

function QrControls({ selected }: { selected: Selected }) {
  const updateQrColors = useCanvasStore((s) => s.updateQrColors);
  const addRecent = useCanvasStore((s) => s.addRecentColor);
  const setBg = (c: string) => {
    addRecent(c === "transparent" ? "" : c);
    void updateQrColors(undefined, c);
  };
  const setFg = (c: string) => {
    addRecent(c);
    void updateQrColors(c, undefined);
  };
  const isTransparent = selected.qrBgColor === "transparent";
  return (
    <>
      <span className="text-[11px] text-vp-muted px-1 shrink-0">QR</span>
      <ColorButton value={selected.qrFgColor || "#000000"} onChange={setFg} />
      <Divider />
      <span className="text-[11px] text-vp-muted px-1 shrink-0">Bg</span>
      <ColorButton
        value={isTransparent ? "#ffffff" : selected.qrBgColor || "#ffffff"}
        onChange={setBg}
      />
      <button
        onClick={() => setBg("transparent")}
        className={[
          "h-7 px-2 rounded text-[11px] font-medium border shrink-0",
          isTransparent
            ? "border-vp-blue text-vp-blue bg-vp-blue-light"
            : "border-vp-border text-vp-ink hover:border-vp-blue",
        ].join(" ")}
        title="Transparent background"
      >
        No bg
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Barcode-specific controls                                           */
/* ------------------------------------------------------------------ */

function BarcodeControls({ selected }: { selected: Selected }) {
  const updateBarcodeColors = useCanvasStore((s) => s.updateBarcodeColors);
  const addRecent = useCanvasStore((s) => s.addRecentColor);
  const setBar = (c: string) => {
    addRecent(c);
    void updateBarcodeColors({ barColor: c });
  };
  const setBg = (c: string) => {
    addRecent(c);
    void updateBarcodeColors({ bgColor: c, hasBg: true });
  };
  const isTransparent = selected.barHasBg === false;
  return (
    <>
      <span className="text-[11px] text-vp-muted px-1 shrink-0">Bars</span>
      <ColorButton value={selected.barColor || "#000000"} onChange={setBar} />
      <Divider />
      <span className="text-[11px] text-vp-muted px-1 shrink-0">Bg</span>
      <ColorButton
        value={isTransparent ? "#ffffff" : selected.barBgColor || "#ffffff"}
        onChange={setBg}
      />
      <button
        onClick={() => void updateBarcodeColors({ hasBg: false })}
        className={[
          "h-7 px-2 rounded text-[11px] font-medium border shrink-0",
          isTransparent
            ? "border-vp-blue text-vp-blue bg-vp-blue-light"
            : "border-vp-border text-vp-ink hover:border-vp-blue",
        ].join(" ")}
        title="Transparent background"
      >
        No bg
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ */

type Selected = NonNullable<
  ReturnType<typeof useCanvasStore.getState>["selected"]
>;
type Patch = ReturnType<typeof useCanvasStore.getState>["patchActive"];

function TextControls({
  selected,
  patch,
}: {
  selected: Selected;
  patch: Patch;
}) {
  return (
    <>
      <FontCombobox
        value={selected.fontFamily}
        onChange={(family) => patch({ fontFamily: family })}
      />

      <Divider />

      <input
        type="number"
        min={8}
        max={200}
        value={Number(selected.fontSize || 20)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n > 0) patch({ fontSize: n });
        }}
        className="w-14 h-7 px-2 text-sm rounded border border-vp-border focus:outline-none focus:border-vp-blue shrink-0"
      />

      <Divider />

      <ColorButton
        value={selected.fill || "#000000"}
        onChange={(c) => patch({ fill: c })}
      />

      <Divider />

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
      <IconToggle
        active={!!selected.underline}
        onClick={() => patch({ underline: !selected.underline })}
        icon={Underline}
        label="Underline"
      />

      <Divider />

      <CasePopover selected={selected} patch={patch} />
      <BulletListButton selected={selected} patch={patch} />

      <Divider />

      <SmartPopover
        align="auto"
        side="auto"
        className="p-1"
        trigger={
          <button
            aria-label="Alignment"
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center shrink-0"
          >
            <AlignmentIcon align={selected.textAlign} />
          </button>
        }
      >
        <div className="flex gap-1">
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
      </SmartPopover>

      <Divider />

      <EffectsPopover />

      <Divider />

      <AdvancedPopover selected={selected} patch={patch} variant="text" />
    </>
  );
}

function ObjectControls({
  selected,
  patch,
}: {
  selected: Selected;
  patch: Patch;
}) {
  return (
    <>
      <ColorButton
        value={selected.fill || "#000000"}
        onChange={(c) => patch({ fill: c })}
      />
      <Divider />
      <StrokeWidthControl selected={selected} patch={patch} />
      <Divider />
      <EffectsPopover />
      <Divider />
      <AdvancedPopover selected={selected} patch={patch} variant="object" />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stroke width — visible for any non-text/non-image object             */
/* ------------------------------------------------------------------ */

/**
 * Border / line thickness control. Surfaced for every shape variant —
 * solid rects gain an outline when this goes above 0; hollow shapes /
 * lines simply get thicker. The slider doubles as a number input so
 * power users can hit exact print-spec values (e.g. 2 px = 0.2 mm).
 */
function StrokeWidthControl({
  selected,
  patch,
}: {
  selected: Selected;
  patch: Patch;
}) {
  // Hide for text + images; both have their own width semantics in fabric.
  if (selected.type === "text" || selected.type === "image") return null;

  const value = Number(selected.strokeWidth || 0);
  return (
    <SmartPopover
      align="auto"
      side="auto"
      className="w-56 p-3"
      trigger={
        <button
          aria-label="Border thickness"
          title="Border thickness"
          className="h-7 px-2 rounded border border-vp-border text-xs flex items-center gap-1.5 hover:border-vp-blue shrink-0"
        >
          <span className="text-vp-muted">Border</span>
          <span className="font-mono">{value}</span>
        </button>
      }
    >
      <Slider
        label="Border thickness"
        min={0}
        max={40}
        step={1}
        value={value}
        onChange={(v) => patch({ strokeWidth: v })}
        display={`${Math.round(value)} px`}
      />
      <div className="mt-2 flex gap-1.5">
        {[0, 1, 2, 4, 8].map((preset) => (
          <button
            key={preset}
            onClick={() => patch({ strokeWidth: preset })}
            className={[
              "flex-1 h-7 rounded border text-xs font-medium",
              value === preset
                ? "border-vp-blue bg-vp-blue-light text-vp-blue"
                : "border-vp-border hover:border-vp-blue",
            ].join(" ")}
          >
            {preset}
          </button>
        ))}
      </div>
    </SmartPopover>
  );
}

/* ------------------------------------------------------------------ */
/* Effects popover                                                     */
/* ------------------------------------------------------------------ */

function EffectsPopover() {
  // All visual effects are intentionally disabled — they're staged for a
  // later phase once the print pipeline can flatten them safely.
  const styles = [
    { key: "original", label: "Original", active: true },
    { key: "shadow", label: "Shadow", active: false, disabled: true },
    { key: "highlight", label: "Highlight", active: false, disabled: true },
    { key: "glitch", label: "Glitch", active: false, disabled: true },
    { key: "echo", label: "Echo", active: false, disabled: true },
  ];

  return (
    <SmartPopover
      align="auto"
      side="auto"
      className="w-64 p-3"
      trigger={
        <button
          aria-label="Effects"
          className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center shrink-0"
        >
          <Sparkles className="w-4 h-4" />
        </button>
      }
    >
      <div>
        <div className="text-xs font-semibold mb-2">Style</div>
        <div className="grid grid-cols-3 gap-1.5">
          {styles.map((s) => (
            <button
              key={s.key}
              disabled={s.disabled}
              className={[
                "h-9 rounded border text-xs font-medium",
                s.active
                  ? "border-vp-blue bg-vp-blue-light text-vp-blue"
                  : "border-vp-border hover:border-vp-blue text-vp-ink",
                s.disabled
                  ? "opacity-40 cursor-not-allowed hover:border-vp-border"
                  : "",
              ].join(" ")}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <div className="text-xs font-semibold mb-2">Shape</div>
        <div className="grid grid-cols-2 gap-1.5">
          <button className="h-9 rounded border border-vp-blue bg-vp-blue-light text-vp-blue text-xs font-medium">
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
    </SmartPopover>
  );
}

/* ------------------------------------------------------------------ */
/* Advanced popover                                                    */
/* ------------------------------------------------------------------ */

function AdvancedPopover({
  selected,
  patch,
  variant,
}: {
  selected: Selected;
  patch: Patch;
  variant: "text" | "object";
}) {
  return (
    <SmartPopover
      align="auto"
      side="auto"
      className="w-60 p-3 space-y-3"
      trigger={
        <button
          aria-label="Advanced"
          className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center shrink-0"
        >
          <Sliders className="w-4 h-4" />
        </button>
      }
    >
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
      {variant === "text" && (
        <>
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
        </>
      )}
    </SmartPopover>
  );
}

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

function Divider() {
  return <div className="w-px h-5 bg-vp-border mx-0.5 shrink-0" />;
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
        "w-8 h-8 rounded flex items-center justify-center shrink-0",
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
  const addRecent = useCanvasStore((s) => s.addRecentColor);
  return (
    <label
      className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center cursor-pointer shrink-0"
      title="Color"
    >
      <span
        className="w-5 h-5 rounded-full border border-vp-border"
        style={{ background: value }}
      />
      <input
        type="color"
        value={value && value.startsWith("#") ? value : "#000000"}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => addRecent(value)}
        className="sr-only"
      />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Case + list — text-only utilities                                  */
/* ------------------------------------------------------------------ */

function transformCase(text: string, mode: "upper" | "lower" | "title") {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  // Title case: capitalise the first letter of each whitespace-separated word.
  return text
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function CasePopover({ selected, patch }: { selected: Selected; patch: Patch }) {
  const apply = (mode: "upper" | "lower" | "title") => {
    patch({ text: transformCase(selected.text, mode) });
  };
  return (
    <SmartPopover
      align="auto"
      side="auto"
      className="p-1"
      trigger={
        <button
          aria-label="Text case"
          className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center shrink-0"
        >
          <CaseSensitive className="w-4 h-4" />
        </button>
      }
    >
      <button
        onClick={() => apply("upper")}
        className="w-full px-3 py-1.5 text-sm text-left hover:bg-vp-rail rounded"
      >
        UPPERCASE
      </button>
      <button
        onClick={() => apply("lower")}
        className="w-full px-3 py-1.5 text-sm text-left hover:bg-vp-rail rounded"
      >
        lowercase
      </button>
      <button
        onClick={() => apply("title")}
        className="w-full px-3 py-1.5 text-sm text-left hover:bg-vp-rail rounded"
      >
        Title Case
      </button>
    </SmartPopover>
  );
}

/**
 * Toggle bullet list. Detects whether every non-empty line already begins
 * with the bullet sentinel and either strips or prepends accordingly.
 * Fabric.IText doesn't have a real "list" type, so this is a textual
 * approximation — good enough for the most common use case (multi-line
 * label text with bullet points).
 */
const BULLET = "• ";

function BulletListButton({
  selected,
  patch,
}: {
  selected: Selected;
  patch: Patch;
}) {
  const lines = selected.text.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const allBulleted =
    nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(BULLET));

  const toggle = () => {
    const next = lines
      .map((l) =>
        l.startsWith(BULLET)
          ? l.slice(BULLET.length)
          : l.trim().length === 0
            ? l
            : BULLET + l
      )
      .join("\n");
    // If every line already had a bullet, the map above stripped them.
    // Otherwise add bullets to every non-empty line that lacks one.
    const final = allBulleted
      ? lines
          .map((l) => (l.startsWith(BULLET) ? l.slice(BULLET.length) : l))
          .join("\n")
      : lines
          .map((l) =>
            l.trim().length === 0 || l.startsWith(BULLET) ? l : BULLET + l
          )
          .join("\n");
    patch({ text: final });
    // `next` is the toggle result if the row was mixed; we use `final`
    // (idempotent) for clarity. `next` is intentionally unused.
    void next;
  };

  return (
    <button
      aria-label="Bullet list"
      aria-pressed={allBulleted}
      onClick={toggle}
      className={[
        "w-8 h-8 rounded flex items-center justify-center shrink-0",
        allBulleted ? "bg-vp-blue-light text-vp-blue" : "hover:bg-vp-rail",
      ].join(" ")}
    >
      <List className="w-4 h-4" />
    </button>
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
