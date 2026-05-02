import type { fabric } from "fabric";
import {
  ArrowDown,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Copy,
  FlipHorizontal,
  FlipVertical,
  Lock,
  MoreHorizontal,
  Trash2,
  Unlock,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE } from "./Workspace";
import { SmartPopover } from "./SmartPopover";

/**
 * Floating action chip pinned above the active object.
 * Coordinates are CSS pixels relative to the stage element.
 *
 * The "More" submenu carries Phase-2 layer-management actions:
 *   Arrange  — bring forward / send backward / front / back
 *   Align    — center horizontally / vertically (within the trim)
 *   Flip     — horizontal / vertical
 */
export function ObjectActionMenu({
  left,
  top,
}: {
  left: number;
  top: number;
}) {
  const canvas = useCanvasStore((s) => s.canvas);
  const selected = useCanvasStore((s) => s.selected);
  const patch = useCanvasStore((s) => s.patchActive);

  if (!selected) return null;

  const withActive = (fn: (obj: fabric.Object) => void) => {
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
      clone.set({
        left: (obj.left ?? 0) + 20,
        top: (obj.top ?? 0) + 20,
      });
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

  const toggleLock = () => patch({ locked: !selected.locked });

  return (
    <div
      role="toolbar"
      aria-label="Element actions"
      className="absolute bg-white rounded-md shadow-vp-pop border border-vp-border h-9 flex items-center px-1 gap-0.5 z-20 pointer-events-auto"
      style={{
        left: Math.max(0, left),
        top: Math.max(0, top),
      }}
    >
      <Btn label={selected.locked ? "Unlock" : "Lock"} onClick={toggleLock}>
        {selected.locked ? (
          <Unlock className="w-4 h-4" />
        ) : (
          <Lock className="w-4 h-4" />
        )}
      </Btn>
      <Btn label="Duplicate" onClick={duplicate}>
        <Copy className="w-4 h-4" />
      </Btn>
      <Btn label="Delete" onClick={remove}>
        <Trash2 className="w-4 h-4" />
      </Btn>

      <Divider />

      <MoreMenu canvas={canvas} withActive={withActive} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* "More tools" dropdown                                                */
/* ------------------------------------------------------------------ */

function MoreMenu({
  canvas,
  withActive,
}: {
  canvas: fabric.Canvas | null;
  withActive: (fn: (obj: fabric.Object) => void) => void;
}) {
  const arrange = (action: "forward" | "backward" | "front" | "back") => {
    if (!canvas) return;
    const obj = canvas.getActiveObject();
    if (!obj) return;
    if (action === "forward") canvas.bringForward(obj);
    if (action === "backward") canvas.sendBackwards(obj);
    if (action === "front") canvas.bringToFront(obj);
    if (action === "back") canvas.sendToBack(obj);
    canvas.requestRenderAll();
    canvas.fire("object:modified", { target: obj });
  };

  const center = (axis: "h" | "v") => {
    withActive((obj) => {
      const cx = VIRTUAL_SIZE / 2;
      const cy = VIRTUAL_SIZE / 2;
      const br = obj.getBoundingRect(true, true);
      if (axis === "h") {
        obj.left = (obj.left ?? 0) + (cx - (br.left + br.width / 2));
      } else {
        obj.top = (obj.top ?? 0) + (cy - (br.top + br.height / 2));
      }
    });
  };

  const flip = (axis: "h" | "v") => {
    withActive((obj) => {
      if (axis === "h") obj.flipX = !obj.flipX;
      else obj.flipY = !obj.flipY;
    });
  };

  return (
    <SmartPopover
      align="end"
      side="auto"
      className="w-52 py-1"
      trigger={
        <button
          aria-label="More tools"
          className="w-7 h-7 rounded hover:bg-vp-rail flex items-center justify-center"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      }
    >
      <SectionLabel>Arrange</SectionLabel>
      <Item icon={ChevronsUp} label="Bring to front" onClick={() => arrange("front")} />
      <Item icon={ArrowUp} label="Bring forward" onClick={() => arrange("forward")} />
      <Item icon={ArrowDown} label="Send backward" onClick={() => arrange("backward")} />
      <Item icon={ChevronsDown} label="Send to back" onClick={() => arrange("back")} />
      <SectionLabel>Align</SectionLabel>
      <Item label="Center horizontally" onClick={() => center("h")} />
      <Item label="Center vertically" onClick={() => center("v")} />
      <SectionLabel>Flip</SectionLabel>
      <Item icon={FlipHorizontal} label="Flip horizontal" onClick={() => flip("h")} />
      <Item icon={FlipVertical} label="Flip vertical" onClick={() => flip("v")} />
    </SmartPopover>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-vp-muted font-semibold">
      {children}
    </div>
  );
}

function Item({
  icon: Icon,
  label,
  onClick,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full px-3 py-1.5 text-sm text-left hover:bg-vp-rail flex items-center gap-2"
    >
      {Icon ? <Icon className="w-3.5 h-3.5 text-vp-muted" /> : <span className="w-3.5" />}
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */

function Divider() {
  return <div className="w-px h-5 bg-vp-border mx-0.5" />;
}

function Btn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="w-7 h-7 rounded hover:bg-vp-rail flex items-center justify-center text-vp-ink"
    >
      {children}
    </button>
  );
}

