import type { fabric } from "fabric";
import {
  Blend,
  Bold,
  Copy,
  Italic,
  Layers,
  Lock,
  Plus,
  Replace,
  Trash2,
  Unlock,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { SmartPopover } from "../SmartPopover";

/**
 * Vistaprint-style contextual action bar (mobile only).
 *
 * Renders directly above the bottom navigation rail whenever a Fabric
 * object is selected. A pinned primary "+" FAB on the left, then a
 * horizontally scrollable row of object-specific actions (Replace, Color,
 * Opacity, Bold/Italic, Clone, Arrange, Lock, Delete) wired to the same
 * store/canvas operations the desktop toolbars use.
 */
export function MobileSelectionBar() {
  const selected = useCanvasStore((s) => s.selected);
  const previewMode = useCanvasStore((s) => s.previewMode);
  const canvas = useCanvasStore((s) => s.canvas);
  const patch = useCanvasStore((s) => s.patchActive);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const setUploadModalOpen = useCanvasStore((s) => s.setUploadModalOpen);
  const addRecentColor = useCanvasStore((s) => s.addRecentColor);

  if (!selected || previewMode) return null;

  const withActive = (fn: (o: fabric.Object) => void) => {
    const obj = canvas?.getActiveObject();
    if (!canvas || !obj) return;
    fn(obj);
    obj.setCoords();
    canvas.requestRenderAll();
    canvas.fire("object:modified", { target: obj });
  };

  const duplicate = () => {
    const obj = canvas?.getActiveObject();
    if (!canvas || !obj) return;
    obj.clone((clone: any) => {
      clone.set({ left: (obj.left ?? 0) + 20, top: (obj.top ?? 0) + 20 });
      canvas.add(clone);
      canvas.setActiveObject(clone);
      canvas.requestRenderAll();
    });
  };

  const remove = () => {
    const obj = canvas?.getActiveObject();
    if (!canvas || !obj) return;
    canvas.remove(obj);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  };

  const arrange = (action: "forward" | "backward" | "front" | "back") => {
    const obj = canvas?.getActiveObject();
    if (!canvas || !obj) return;
    if (action === "forward") canvas.bringForward(obj);
    if (action === "backward") canvas.sendBackwards(obj);
    if (action === "front") canvas.bringToFront(obj);
    if (action === "back") canvas.sendToBack(obj);
    canvas.requestRenderAll();
    canvas.fire("object:modified", { target: obj });
  };

  const isText = selected.type === "text";
  const isImage = selected.type === "image";
  // Fill-color only makes sense for text + fillable shapes (QR / barcode /
  // image recolour via their own regenerators, not a plain fill).
  const showColor = isText || selected.type === "shape";

  return (
    <div
      role="toolbar"
      aria-label="Object actions"
      className="md:hidden fixed bottom-[calc(74px_+_env(safe-area-inset-bottom))] left-0 w-full z-40 flex items-stretch bg-white/90 backdrop-blur border-t border-gray-200/70 shadow-md"
    >
      {/* Primary FAB — opens the add-element (Shapes) sheet. */}
      <div className="shrink-0 flex items-center pl-3 pr-2 py-2">
        <button
          type="button"
          aria-label="Add element"
          onClick={() => setActiveTool("graphics")}
          className="w-11 h-11 rounded-2xl bg-vp-blue text-white flex items-center justify-center shadow-md active:scale-95 transition-transform"
        >
          <Plus className="w-6 h-6" strokeWidth={2.4} />
        </button>
      </div>

      {/* Scrollable actions */}
      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto hide-scrollbar px-1 py-1.5">
        {isImage && (
          <ActionButton
            icon={Replace}
            label="Replace"
            onClick={() => {
              setActiveTool("uploads");
              setUploadModalOpen(true);
            }}
          />
        )}

        {showColor && (
          <label
            className="shrink-0 flex flex-col items-center justify-center gap-1 w-[58px] h-[52px] rounded-lg text-[10px] font-medium text-slate-600 active:bg-slate-100 cursor-pointer"
            title="Color"
          >
            <span
              className="w-6 h-6 rounded-full border border-vp-border shadow-sm"
              style={{ background: selected.fill || "#000000" }}
            />
            <span>Color</span>
            <input
              type="color"
              value={
                selected.fill && selected.fill.startsWith("#")
                  ? selected.fill
                  : "#000000"
              }
              onChange={(e) => patch({ fill: e.target.value })}
              onBlur={() => addRecentColor(selected.fill || "#000000")}
              className="sr-only"
            />
          </label>
        )}

        {isText && (
          <>
            <ActionButton
              icon={Bold}
              label="Bold"
              active={selected.fontWeight === "bold"}
              onClick={() =>
                patch({
                  fontWeight: selected.fontWeight === "bold" ? "normal" : "bold",
                })
              }
            />
            <ActionButton
              icon={Italic}
              label="Italic"
              active={selected.fontStyle === "italic"}
              onClick={() =>
                patch({
                  fontStyle:
                    selected.fontStyle === "italic" ? "normal" : "italic",
                })
              }
            />
          </>
        )}

        {/* Opacity */}
        <SmartPopover
          side="top"
          align="auto"
          className="w-56 p-3"
          trigger={
            <PopoverTrigger icon={Blend} label="Opacity" />
          }
        >
          <SliderRow
            label="Opacity"
            min={0}
            max={1}
            step={0.01}
            value={Number(selected.opacity ?? 1)}
            onChange={(v) => patch({ opacity: v })}
            display={`${Math.round(Number(selected.opacity ?? 1) * 100)}%`}
          />
        </SmartPopover>

        {/* Arrange (layer order) */}
        <SmartPopover
          side="top"
          align="auto"
          className="w-48 py-1"
          trigger={<PopoverTrigger icon={Layers} label="Arrange" />}
        >
          <MenuItem label="Bring to front" onClick={() => arrange("front")} />
          <MenuItem label="Bring forward" onClick={() => arrange("forward")} />
          <MenuItem label="Send backward" onClick={() => arrange("backward")} />
          <MenuItem label="Send to back" onClick={() => arrange("back")} />
        </SmartPopover>

        <ActionButton icon={Copy} label="Clone" onClick={duplicate} />

        <ActionButton
          icon={selected.locked ? Unlock : Lock}
          label={selected.locked ? "Unlock" : "Lock"}
          active={selected.locked}
          onClick={() => patch({ locked: !selected.locked })}
        />

        <ActionButton
          icon={Trash2}
          label="Delete"
          danger
          onClick={remove}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ActionButton({
  icon: Icon,
  label,
  onClick,
  active,
  danger,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={[
        "shrink-0 flex flex-col items-center justify-center gap-1 w-[58px] h-[52px] rounded-lg text-[10px] font-medium transition-colors active:bg-slate-100",
        danger
          ? "text-red-600"
          : active
            ? "text-vp-blue"
            : "text-slate-600",
      ].join(" ")}
    >
      <Icon className="w-5 h-5" strokeWidth={1.8} />
      <span>{label}</span>
    </button>
  );
}

/**
 * Trigger used inside SmartPopover — mirrors ActionButton's look but is a
 * plain element SmartPopover attaches its handlers to.
 */
function PopoverTrigger({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="shrink-0 flex flex-col items-center justify-center gap-1 w-[58px] h-[52px] rounded-lg text-[10px] font-medium text-slate-600 active:bg-slate-100"
    >
      <Icon className="w-5 h-5" strokeWidth={1.8} />
      <span>{label}</span>
    </button>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-3 py-2 text-sm text-left hover:bg-vp-rail rounded"
    >
      {label}
    </button>
  );
}

function SliderRow({
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
      <div className="flex items-center justify-between text-xs mb-1.5">
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
