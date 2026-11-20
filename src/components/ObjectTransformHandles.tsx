import { useRef, useState } from "react";
import type { RefObject } from "react";
import { Move, RotateCw } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";

/**
 * VistaPrint-style Drag + Rotate cluster, rendered centred directly below
 * the selected object's bounding box (position computed in Workspace from
 * the same `scale = fitScale × zoom` projection the ObjectActionMenu uses).
 *
 * Unified Pointer Events (mouse + touch) with pointer capture + CSS
 * `touch-action: none` so mobile never scrolls / rubber-bands mid-gesture:
 *
 *  - Drag  → translates the active object by the pointer delta ÷ scale,
 *            firing `object:moving` each step so Smart Guides snapping
 *            runs, then ONE `object:modified` (→ one history snapshot).
 *  - Rotate→ rotates around the object's fixed centre with ±4° magnetic
 *            snap to 0/90/180/270 (15° steps with Shift), a live degree
 *            pill, then ONE `object:modified`.
 *
 * Axis/rotation locks are respected (a partially-locked object still shows
 * the cluster but only the unlocked transforms apply).
 */
export function ObjectTransformHandles({
  left,
  top,
  stageRef,
  getScale,
}: {
  left: number;
  top: number;
  stageRef: RefObject<HTMLDivElement | null>;
  getScale: () => number;
}) {
  const canvas = useCanvasStore((s) => s.canvas);
  // Subscribe to the store's selection so the cluster re-renders — and
  // unmounts — the instant the selection clears, independent of the
  // position state Workspace feeds in.
  const selected = useCanvasStore((s) => s.selected);
  const [degPill, setDegPill] = useState<number | null>(null);
  const dragRef = useRef<{ lastX: number; lastY: number; moved: boolean } | null>(
    null
  );
  const rotRef = useRef<{
    center: any;
    cvx: number;
    cvy: number;
    startPointer: number;
    startAngle: number;
    changed: boolean;
  } | null>(null);

  // Strict visibility guard: no canvas, no store selection, or no live
  // Fabric active object → render nothing (belt-and-braces alongside the
  // Workspace `transformHandles.visible` gate).
  if (!canvas || !selected || !canvas.getActiveObject()) return null;

  /* --------------------------- Drag --------------------------- */
  const onDragDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const active = canvas.getActiveObject();
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    dragRef.current = { lastX: e.clientX, lastY: e.clientY, moved: false };
  };

  const onDragMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const active = canvas.getActiveObject();
    if (!active) return;
    const scale = getScale() || 1;
    const dx = (e.clientX - d.lastX) / scale;
    const dy = (e.clientY - d.lastY) / scale;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    const a = active as any;
    let changed = false;
    if (!a.lockMovementX && dx) {
      active.set({ left: (active.left ?? 0) + dx });
      changed = true;
    }
    if (!a.lockMovementY && dy) {
      active.set({ top: (active.top ?? 0) + dy });
      changed = true;
    }
    if (changed) {
      active.setCoords();
      // Fire Fabric's own event so Smart Guides / snapping engages.
      canvas.fire("object:moving", { target: active, e: e.nativeEvent } as any);
      canvas.requestRenderAll();
      d.moved = true;
    }
  };

  const onDragUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    // Clear any Smart-Guide lines (they listen to mouse:up).
    canvas.fire("mouse:up");
    const active = canvas.getActiveObject();
    if (active && d && d.moved) {
      active.setCoords();
      // One clean history snapshot (history listens to object:modified).
      canvas.fire("object:modified", { target: active } as any);
      canvas.requestRenderAll();
    }
  };

  /* -------------------------- Rotate -------------------------- */
  const onRotDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const active = canvas.getActiveObject();
    if (!active) return;
    if ((active as any).lockRotation) return;
    const stage = stageRef.current;
    if (!stage) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    const rect = stage.getBoundingClientRect();
    const scale = getScale() || 1;
    const c = active.getCenterPoint();
    const cvx = rect.left + c.x * scale;
    const cvy = rect.top + c.y * scale;
    const startPointer =
      (Math.atan2(e.clientY - cvy, e.clientX - cvx) * 180) / Math.PI;
    rotRef.current = {
      center: c,
      cvx,
      cvy,
      startPointer,
      startAngle: active.angle ?? 0,
      changed: false,
    };
    setDegPill(Math.round((((active.angle ?? 0) % 360) + 360) % 360));
  };

  const onRotMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = rotRef.current;
    if (!r) return;
    const active = canvas.getActiveObject();
    if (!active) return;
    const cur = (Math.atan2(e.clientY - r.cvy, e.clientX - r.cvx) * 180) / Math.PI;
    let raw = r.startAngle + (cur - r.startPointer);
    raw = ((raw % 360) + 360) % 360;
    let snapped = raw;
    if (e.shiftKey) {
      snapped = Math.round(raw / 15) * 15;
    } else {
      for (const t of [0, 90, 180, 270, 360]) {
        if (Math.abs(raw - t) <= 4) {
          snapped = t;
          break;
        }
      }
    }
    snapped = ((snapped % 360) + 360) % 360;
    active.set({ angle: snapped });
    // Keep the ORIGINAL centre fixed so it rotates about its centre
    // (programmatic `angle` alone would pivot around the top-left origin).
    active.setPositionByOrigin(r.center, "center", "center");
    active.setCoords();
    canvas.fire("object:rotating", { target: active, e: e.nativeEvent } as any);
    canvas.requestRenderAll();
    r.changed = true;
    setDegPill(Math.round(snapped));
  };

  const onRotUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = rotRef.current;
    rotRef.current = null;
    setDegPill(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    const active = canvas.getActiveObject();
    if (active && r && r.changed) {
      active.setCoords();
      canvas.fire("object:modified", { target: active } as any);
      canvas.requestRenderAll();
    }
  };

  const btn =
    "w-9 h-9 rounded-full bg-white border border-gray-200 shadow-md flex items-center justify-center text-[#0099ff] select-none touch-none active:bg-slate-50 cursor-grab";

  return (
    <div
      className="absolute z-20 pointer-events-none"
      style={{
        left: Math.max(0, left),
        top: Math.max(0, top),
        transform: "translateX(-50%)",
      }}
    >
      {degPill != null && (
        <div
          className="absolute left-1/2 -translate-x-1/2 -top-8 px-2 h-6 rounded-full bg-slate-900 text-white text-[11px] font-semibold tabular-nums flex items-center justify-center shadow-md pointer-events-none"
          aria-hidden
        >
          {degPill}°
        </div>
      )}
      <div className="flex items-center gap-2 pointer-events-auto">
        <button
          type="button"
          aria-label="Drag to move"
          title="Drag to move"
          className={btn}
          style={{ touchAction: "none" }}
          onPointerDown={onDragDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
          onPointerCancel={onDragUp}
        >
          <Move className="w-4 h-4" strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label="Drag to rotate"
          title="Drag to rotate"
          className={btn}
          style={{ touchAction: "none" }}
          onPointerDown={onRotDown}
          onPointerMove={onRotMove}
          onPointerUp={onRotUp}
          onPointerCancel={onRotUp}
        >
          <RotateCw className="w-4 h-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
