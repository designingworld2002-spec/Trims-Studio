import { useEffect, useRef, useState, useCallback } from "react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { HistoryManager } from "@/lib/history";
import { Autosave, loadSavedDesign, syncWorkIdToUrl } from "@/lib/autosave";
import { TopContextualToolbar } from "./TopContextualToolbar";
import { ObjectActionMenu } from "./ObjectActionMenu";

/**
 * Virtual workspace constants.
 *
 * The fabric canvas is a fixed 2000×2000 px stage (the "Vistaprint
 * cardstock"). The user's product (e.g. 90×50 mm) lives centered inside it
 * as a "trim" rectangle, surrounded by Bleed (+2mm) and Safety (−2mm) guides.
 * We never resize the fabric canvas itself — instead we scale it via CSS
 * `transform: scale(...)` so it fits ~90% of the viewport without ever
 * losing internal precision. This is identical to how Vistaprint and Canva
 * handle their print stage.
 */
export const VIRTUAL_SIZE = 2000;
export const MM_TO_PX = 10; // 1 mm = 10 internal px
/** Safe area inset from the bleed edges, on every side, in mm. */
export const SAFETY_MM = 2;

const GUIDE_IDS = {
  bleed: "bleed",
  safety: "safety",
} as const;

/* ------------------------------------------------------------------ */
/* Guide layer                                                         */
/* ------------------------------------------------------------------ */

interface GuideRects {
  bleed: fabric.Rect;
  safety: fabric.Rect;
  bleedLeft: number;
  bleedTop: number;
  bleedW: number;
  bleedH: number;
  safetyLeft: number;
  safetyTop: number;
  safetyW: number;
  safetyH: number;
}

/**
 * Remove any existing guide rectangles and (re)draw the two-layer Vistaprint
 * guide stack:
 *
 *   1. **Bleed** — the master rectangle. Filled with the user-chosen
 *      background colour, dashed yellow border, sized to the URL/store
 *      `length × width`.
 *   2. **Safety** — `bleed - 4mm` (2 mm inset on every edge), transparent
 *      fill, dashed green border. Drives the strict clipPath applied to
 *      every user object.
 *
 * Both are sent to the back so user content layers on top, but they remain
 * `excludeFromExport` so they never appear in the JSON snapshot or in
 * `canvas.toDataURL` exports.
 */
function drawGuides(
  canvas: fabric.Canvas,
  lengthMm: number,
  widthMm: number,
  bgFill: string
): GuideRects {
  // Wipe existing guides (HMR, undo restores, dim changes).
  canvas
    .getObjects()
    .filter((o) => {
      const id = (o as any).id;
      return id === GUIDE_IDS.bleed || id === GUIDE_IDS.safety;
    })
    .forEach((o) => canvas.remove(o));

  // X axis = length, Y axis = width. Bleed dimensions come straight from
  // the store — they are the master size.
  const bleedW = lengthMm * MM_TO_PX;
  const bleedH = widthMm * MM_TO_PX;
  const safetyW = Math.max(1, bleedW - SAFETY_MM * 2 * MM_TO_PX);
  const safetyH = Math.max(1, bleedH - SAFETY_MM * 2 * MM_TO_PX);

  const cx = VIRTUAL_SIZE / 2;
  const cy = VIRTUAL_SIZE / 2;

  const bleedLeft = cx - bleedW / 2;
  const bleedTop = cy - bleedH / 2;
  const safetyLeft = cx - safetyW / 2;
  const safetyTop = cy - safetyH / 2;

  const baseProps: Partial<fabric.IObjectOptions> = {
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    hoverCursor: "default",
  };
  const baseAny = { excludeFromExport: true } as any;

  // 1) Bleed — the visible "card". Filled with the user's bg colour,
  //    dashed yellow stroke, soft drop shadow.
  const bleed = new fabric.Rect({
    left: bleedLeft,
    top: bleedTop,
    width: bleedW,
    height: bleedH,
    fill: bgFill,
    stroke: "#eab308",
    strokeWidth: 2,
    strokeDashArray: [10, 6],
    strokeUniform: true,
    shadow: new fabric.Shadow({
      color: "rgba(0,0,0,0.12)",
      blur: 24,
      offsetX: 0,
      offsetY: 4,
    }),
    ...baseProps,
  });
  (bleed as any).id = GUIDE_IDS.bleed;
  Object.assign(bleed, baseAny);

  // 2) Safety — dashed green inside the bleed.
  const safety = new fabric.Rect({
    left: safetyLeft,
    top: safetyTop,
    width: safetyW,
    height: safetyH,
    fill: "transparent",
    stroke: "#22c55e",
    strokeWidth: 2,
    strokeDashArray: [8, 5],
    strokeUniform: true,
    ...baseProps,
  });
  (safety as any).id = GUIDE_IDS.safety;
  Object.assign(safety, baseAny);

  canvas.add(bleed, safety);
  canvas.sendToBack(safety);
  canvas.sendToBack(bleed);
  canvas.requestRenderAll();

  return {
    bleed,
    safety,
    bleedLeft,
    bleedTop,
    bleedW,
    bleedH,
    safetyLeft,
    safetyTop,
    safetyW,
    safetyH,
  };
}

/* ------------------------------------------------------------------ */
/* Strict masking — user objects clip to the safe area                 */
/* ------------------------------------------------------------------ */

/**
 * Build an `absolutePositioned` Rect that fabric will use as a clipPath
 * on user objects. Positioned in canvas coordinates (NOT object-relative)
 * so it stays put even when the wrapped object moves.
 */
function buildSafeAreaClip(g: GuideRects): fabric.Rect {
  return new fabric.Rect({
    left: g.safetyLeft,
    top: g.safetyTop,
    width: g.safetyW,
    height: g.safetyH,
    absolutePositioned: true,
  });
}

/**
 * Apply (or reapply) the safe-area clip to every user object on the canvas.
 * Guides themselves are skipped — they need to render on top, unmasked.
 */
function applySafeAreaClipToAllObjects(
  canvas: fabric.Canvas,
  g: GuideRects | null
) {
  if (!g) return;
  canvas.getObjects().forEach((o) => {
    if ((o as any).excludeFromExport) return;
    o.clipPath = buildSafeAreaClip(g);
  });
  canvas.requestRenderAll();
}

/* ------------------------------------------------------------------ */
/* Template payload extraction                                         */
/* ------------------------------------------------------------------ */

/**
 * Resolve the raw fabric JSON from a template document. Trims-authored
 * templates wrap fabric payloads in metadata:
 *
 *   {
 *     id, description, thumbnailUrl, sourceImage, createdAt,
 *     canvas: { width, height },
 *     editableFields: [...],
 *     fabric: { version, objects, background, ... }   ← we want this
 *   }
 *
 * Hand-authored templates can be raw `canvas.toJSON()` output, which has
 * `objects` at the root. We accept either.
 */
function extractFabricPayload(raw: any): any | null {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw.objects)) return raw;
  if (raw.fabric && Array.isArray(raw.fabric.objects)) return raw.fabric;
  return null;
}

/**
 * Normalize a third-party fabric payload before handing it to
 * `canvas.loadFromJSON`. We do two things:
 *
 *  1. Strip `width` / `height` so fabric doesn't resize our virtual stage
 *     to the template's authoring dimensions (e.g. 1000×620). The 2000×2000
 *     stage is load-bearing for our guides + fit logic — anything smaller
 *     and template content gets clipped to the canvas viewport.
 *
 *  2. Ensure every IText/Textbox has a `styles` property. Fabric's
 *     `stylesToArray` (called inside `canvas.toJSON`) crashes when `styles`
 *     is `undefined`, which is how Trims/Vistaprint exporters often emit
 *     un-styled text runs.
 */
function sanitizeFabricPayload(payload: any): any {
  if (!payload || !Array.isArray(payload.objects)) return payload;

  delete payload.width;
  delete payload.height;

  const TEXT_TYPES = new Set(["i-text", "text", "textbox"]);
  const visit = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    if (TEXT_TYPES.has(obj.type)) {
      if (obj.styles == null) obj.styles = {};
    }
    if (Array.isArray(obj.objects)) obj.objects.forEach(visit);
  };
  payload.objects.forEach(visit);
  return payload;
}

/* ------------------------------------------------------------------ */
/* Template fit                                                        */
/* ------------------------------------------------------------------ */

/**
 * After `canvas.loadFromJSON`, scale and translate every user object so
 * the composition **fills the entire bleed boundary** — no gaps on any
 * side. We use `Math.max` of the per-axis scales (cover-fit), which means
 * a template authored with a different aspect ratio than the URL bleed
 * will overflow on one axis. The overflow is fine: the safe-area
 * `clipPath` applied to every user object hides anything that escapes
 * the visible region, while the bleed rectangle itself is fully covered.
 *
 * We mutate each object directly rather than going through Group /
 * ActiveSelection — fabric's selection wrappers have edge cases around
 * detached canvases and re-grouping that bit us in earlier iterations.
 */
function fitTemplateObjectsToBleed(
  canvas: fabric.Canvas,
  lengthMm: number,
  widthMm: number
) {
  const userObjects = canvas
    .getObjects()
    .filter((o) => !(o as any).excludeFromExport);
  if (userObjects.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  userObjects.forEach((o) => {
    const r = o.getBoundingRect(true, true);
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.left + r.width);
    maxY = Math.max(maxY, r.top + r.height);
  });
  const bbW = Math.max(1, maxX - minX);
  const bbH = Math.max(1, maxY - minY);

  const bleedW = lengthMm * MM_TO_PX;
  const bleedH = widthMm * MM_TO_PX;
  const cx = VIRTUAL_SIZE / 2;
  const cy = VIRTUAL_SIZE / 2;
  // Cover-fit: scale by the LARGER per-axis ratio so the bleed is filled
  // edge-to-edge with no gaps. Overflow is clipped by the safe-area mask.
  const scale = Math.max(bleedW / bbW, bleedH / bbH);
  const oldCenterX = (minX + maxX) / 2;
  const oldCenterY = (minY + maxY) / 2;

  userObjects.forEach((o) => {
    o.scaleX = (o.scaleX ?? 1) * scale;
    o.scaleY = (o.scaleY ?? 1) * scale;
    o.left = cx + ((o.left ?? 0) - oldCenterX) * scale;
    o.top = cy + ((o.top ?? 0) - oldCenterY) * scale;
    o.setCoords();
  });
  canvas.requestRenderAll();
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function Workspace() {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const guidesRef = useRef<GuideRects | null>(null);
  const historyRef = useRef<HistoryManager | null>(null);
  const autosaveRef = useRef<Autosave | null>(null);

  const setCanvas = useCanvasStore((s) => s.setCanvas);
  const updateActiveObject = useCanvasStore((s) => s.updateActiveObject);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const templateJsonUrl = useCanvasStore((s) => s.templateJsonUrl);
  const backgroundColor = useCanvasStore((s) => s.backgroundColor);
  const zoom = useCanvasStore((s) => s.zoom);
  const setHistoryFlags = useCanvasStore((s) => s.setHistoryFlags);

  const [fitScale, setFitScale] = useState(1);

  // Position of floating action menu in CSS pixels relative to the stage.
  const [actionMenuPos, setActionMenuPos] = useState<{
    left: number;
    top: number;
    visible: boolean;
  }>({ left: 0, top: 0, visible: false });

  /* ----- Initialise fabric canvas ONCE ----- */
  useEffect(() => {
    if (!canvasElRef.current) return;

    const canvas = new fabric.Canvas(canvasElRef.current, {
      width: VIRTUAL_SIZE,
      height: VIRTUAL_SIZE,
      backgroundColor: "transparent",
      preserveObjectStacking: true,
      selection: true,
    });

    // Sync selection/modification events into Zustand.
    // We wrap in setTimeout(..., 0) so React state updates happen AFTER
    // fabric finishes mutating the object — avoids render-phase clashes
    // (the classic React+Fabric "white screen" footgun).
    const sync = () => {
      window.setTimeout(() => {
        const active = canvas.getActiveObject() ?? null;
        updateActiveObject(active);
        updateActionMenuPos(canvas);
      }, 0);
    };
    const clear = () => {
      window.setTimeout(() => {
        updateActiveObject(null);
        setActionMenuPos((p) => ({ ...p, visible: false }));
      }, 0);
    };

    canvas.on("selection:created", sync);
    canvas.on("selection:updated", sync);
    canvas.on("selection:cleared", clear);
    canvas.on("object:modified", sync);
    canvas.on("object:scaling", () => updateActionMenuPos(canvas));
    canvas.on("object:rotating", () => updateActionMenuPos(canvas));

    // Drag handler — no hard clamp anymore. Each user object carries an
    // absolute-positioned `clipPath` matching the safety rectangle, so any
    // portion of the object that escapes the safe area is visually hidden
    // (per spec: "soft clip", not "hard block"). We just keep the floating
    // ObjectActionMenu in sync with the new position.
    canvas.on("object:moving", () => {
      updateActionMenuPos(canvas);
    });

    // Auto-clip every newly added user object to the current safe area so
    // shapes/text/images dropped onto the canvas inherit the mask.
    canvas.on("object:added", (opt) => {
      const target = opt.target;
      if (!target || (target as any).excludeFromExport) return;
      const g = guidesRef.current;
      if (g) target.clipPath = buildSafeAreaClip(g);
    });

    setCanvas(canvas);
    if (import.meta.env.DEV) {
      (window as any).__trimsCanvas = canvas;
      (window as any).__trimsStore = useCanvasStore;
    }

    // Wire history.
    // NOTE: the callback receives the manager as an argument rather than
    // closing over the local `hist` binding — `new HistoryManager()` triggers
    // an initial snapshot synchronously inside the constructor, which would
    // hit a Temporal Dead Zone if we read `hist` from the closure before the
    // assignment completes.
    const hist = new HistoryManager(canvas, (mgr) => {
      setHistoryFlags(mgr.canUndo(), mgr.canRedo());
      // After an undo/redo, `loadFromJSON` clears every object — including
      // our guides, since they're flagged `excludeFromExport` and therefore
      // never appear in the snapshot. Re-draw them so the user keeps seeing
      // the bleed/safe rectangles + dimension labels after a restore.
      const hasGuides = canvas
        .getObjects()
        .some((o) => (o as any).id === GUIDE_IDS.bleed);
      if (!hasGuides) {
        mgr.pause();
        const s = useCanvasStore.getState();
        guidesRef.current = drawGuides(
          canvas,
          s.canvasLengthMm,
          s.canvasWidthMm,
          s.backgroundColor
        );
        // Re-apply the safe-area clip to every restored user object.
        applySafeAreaClipToAllObjects(canvas, guidesRef.current);
        mgr.resume(false);
      }
    });
    historyRef.current = hist;
    _registerHistory(hist);

    // Wire auto-save. The store's `workId` is seeded from the URL on mount
    // (App.tsx); we pull the LATEST value here in case it was set already.
    const initialWorkId = useCanvasStore.getState().workId;
    const auto = new Autosave({
      canvas,
      initialWorkId,
      getMeta: () => {
        const s = useCanvasStore.getState();
        return {
          lengthMm: s.canvasLengthMm,
          widthMm: s.canvasWidthMm,
          productSlug: s.productSlug,
        };
      },
      onSaved: (id) => {
        useCanvasStore.getState().setWorkId(id);
        useCanvasStore.getState().markSaved();
        syncWorkIdToUrl(id);
      },
    });
    autosaveRef.current = auto;

    return () => {
      _registerHistory(null);
      hist.dispose();
      auto.flush();
      auto.dispose();
      canvas.dispose();
      setCanvas(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- Update guides + rescale user content whenever dims change ----- */
  /*
   * When the user changes the bleed dimensions in the Product Options panel,
   * we don't just resize the bleed/safe rectangles — we also scale every
   * existing user object proportionally around the canvas centre so the
   * design tracks the new size. Without this, going 120 × 70 → 60 × 35
   * would leave content at its original pixel size, which gets clipped to
   * the now-smaller safe area and looks broken.
   *
   * The scale factor uses `Math.min(newL/oldL, newW/oldW)` so a uniform
   * resize (e.g. 50 % on both axes) shrinks content by the same 50 %, while
   * a one-axis change uses the smaller ratio so nothing overflows.
   *
   * History snapshots are paused around the rescale because the operation
   * mutates many objects at once and we don't want every micro-change in
   * the undo stack — the whole resize is one logical step.
   */
  const prevDimsRef = useRef({ length: lengthMm, width: widthMm });
  useEffect(() => {
    const canvas = useCanvasStore.getState().canvas;
    if (!canvas) return;

    const prev = prevDimsRef.current;
    const dimsChanged = prev.length !== lengthMm || prev.width !== widthMm;

    if (dimsChanged && prev.length > 0 && prev.width > 0) {
      const scale = Math.min(lengthMm / prev.length, widthMm / prev.width);
      if (scale > 0 && scale !== 1) {
        const cx = VIRTUAL_SIZE / 2;
        const cy = VIRTUAL_SIZE / 2;
        const hist = historyRef.current;
        hist?.pause();
        canvas.getObjects().forEach((o) => {
          if ((o as any).excludeFromExport) return;
          o.scaleX = (o.scaleX ?? 1) * scale;
          o.scaleY = (o.scaleY ?? 1) * scale;
          o.left = cx + ((o.left ?? 0) - cx) * scale;
          o.top = cy + ((o.top ?? 0) - cy) * scale;
          o.setCoords();
        });
        hist?.resume(false);
      }
    }
    prevDimsRef.current = { length: lengthMm, width: widthMm };

    guidesRef.current = drawGuides(canvas, lengthMm, widthMm, backgroundColor);
    // Re-apply the safe-area mask to every existing user object — when the
    // safety rect resizes, every clipPath needs to follow.
    applySafeAreaClipToAllObjects(canvas, guidesRef.current);
  }, [lengthMm, widthMm, backgroundColor]);

  /* ----- Resume an in-progress design from workId in the URL ----- */
  useEffect(() => {
    const canvas = useCanvasStore.getState().canvas;
    const workId = useCanvasStore.getState().workId;
    if (!canvas || !workId) return;
    // If a template is also being loaded, the template effect will run after
    // and overwrite us — that's fine, it represents a fresh template choice.
    const saved = loadSavedDesign(workId);
    if (!saved) return;
    const hist = historyRef.current;
    hist?.pause();
    canvas.loadFromJSON(saved.fabric, () => {
      if (canvas.width !== VIRTUAL_SIZE || canvas.height !== VIRTUAL_SIZE) {
        canvas.setDimensions({ width: VIRTUAL_SIZE, height: VIRTUAL_SIZE });
      }
      canvas.backgroundColor = "transparent";
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      guidesRef.current = drawGuides(
        canvas,
        saved.lengthMm,
        saved.widthMm,
        backgroundColor
      );
      applySafeAreaClipToAllObjects(canvas, guidesRef.current);
      hist?.resume(true);
    });
    // We deliberately only resume once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- Load template JSON if provided (then redraw guides on top) ----- */
  useEffect(() => {
    const canvas = useCanvasStore.getState().canvas;
    if (!canvas || !templateJsonUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(templateJsonUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        if (cancelled) return;

        // Trims templates wrap the fabric payload inside a `fabric` field
        // alongside metadata (id, description, editableFields, …). We also
        // support raw fabric exports for hand-authored templates.
        const fabricJson = sanitizeFabricPayload(extractFabricPayload(raw));
        if (!fabricJson) {
          throw new Error("Template JSON has no fabric payload");
        }

        // The URL is king: `length` and `width` are the absolute bleed
        // dimensions. The template's authoring aspect must NOT override
        // them — fill-mode scaling below stretches the template to cover
        // the full bleed area instead.

        // Pause history snapshots during the bulk load. Each `object:added`
        // would otherwise call `canvas.toJSON()` while the canvas is in a
        // half-hydrated state, which can crash fabric's serializer.
        const hist = historyRef.current;
        hist?.pause();

        // loadFromJSON wipes the canvas, so any pre-existing guides are gone.
        // We add them back AFTER user objects are placed, so user content
        // sits on top of the trim card.
        canvas.loadFromJSON(fabricJson, () => {
          if (cancelled) {
            hist?.resume(false);
            return;
          }
          // Belt-and-suspenders: even with width/height stripped from the
          // payload, some fabric versions still poke `_setDimensions`. Force
          // the stage back to our virtual size before we lay anything out.
          if (canvas.width !== VIRTUAL_SIZE || canvas.height !== VIRTUAL_SIZE) {
            canvas.setDimensions({ width: VIRTUAL_SIZE, height: VIRTUAL_SIZE });
          }
          // Templates often carry their own canvas-level background color
          // and viewport transform — we never want either; the bleed rect
          // is our visible background and we render in 1:1 canvas coords.
          canvas.backgroundColor = "transparent";
          canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
          fitTemplateObjectsToBleed(canvas, lengthMm, widthMm);
          guidesRef.current = drawGuides(
            canvas,
            lengthMm,
            widthMm,
            backgroundColor
          );
          // Apply the safe-area clipPath to every restored object.
          applySafeAreaClipToAllObjects(canvas, guidesRef.current);
          // Resume + take ONE snapshot representing the loaded template.
          hist?.resume(true);
        });
      } catch (e) {
        console.warn("[trims-studio] Template JSON load failed:", e);
        // Keep an empty canvas with guides so the user can still edit.
        guidesRef.current = drawGuides(
          canvas,
          lengthMm,
          widthMm,
          backgroundColor
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateJsonUrl]);

  /* ----- Position the floating ObjectActionMenu in CSS pixels ----- */
  const updateActionMenuPos = useCallback((canvas: fabric.Canvas) => {
    const active = canvas.getActiveObject();
    const stage = stageRef.current;
    if (!active || !stage) {
      setActionMenuPos((p) => ({ ...p, visible: false }));
      return;
    }
    if ((active as any).excludeFromExport) {
      setActionMenuPos((p) => ({ ...p, visible: false }));
      return;
    }
    // Convert object's bounding rect (canvas coords) into CSS pixels by
    // multiplying by the current fit scale. The stage element shares the
    // canvas top-left, so no additional offset is needed.
    const br = active.getBoundingRect(true, true);
    const scale = fitScaleRef.current * zoomRef.current;
    setActionMenuPos({
      left: br.left * scale,
      top: br.top * scale - 48, // 48px above bounding rect
      visible: true,
    });
  }, []);

  // Use refs for fitScale + zoom so updateActionMenuPos always sees latest.
  const fitScaleRef = useRef(1);
  const zoomRef = useRef(1);
  fitScaleRef.current = fitScale;
  zoomRef.current = zoom;

  // Recompute action menu position when scale changes.
  useEffect(() => {
    const canvas = useCanvasStore.getState().canvas;
    if (canvas && canvas.getActiveObject()) updateActionMenuPos(canvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitScale, zoom]);

  /* ----- Fit-to-90% via ResizeObserver on the container ----- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      // Use 90% of the smaller axis so the canvas always fits comfortably.
      const target = Math.min(rect.width, rect.height) * 0.9;
      const next = target / VIRTUAL_SIZE;
      setFitScale(next > 0 ? next : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalScale = fitScale * zoom;
  const stagePxSize = VIRTUAL_SIZE * totalScale;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full flex items-center justify-center overflow-hidden"
    >
      {/* Stage: a fixed-size box that we transform. */}
      <div
        ref={stageRef}
        className="relative"
        style={{
          width: stagePxSize,
          height: stagePxSize,
        }}
      >
        {/* Canvas itself, sized at virtual resolution and visually scaled. */}
        <div
          className="absolute top-0 left-0 origin-top-left vp-canvas-shadow"
          style={{
            width: VIRTUAL_SIZE,
            height: VIRTUAL_SIZE,
            transform: `scale(${totalScale})`,
            transformOrigin: "top left",
          }}
        >
          <canvas ref={canvasElRef} />
        </div>

        {/* External labels for Trim Size and Bleed Size — positioned
            relative to the scaled stage in CSS pixels. */}
        <CanvasLabels
          lengthMm={lengthMm}
          widthMm={widthMm}
          stagePx={stagePxSize}
        />

        {/* Floating per-object actions */}
        {actionMenuPos.visible && (
          <ObjectActionMenu left={actionMenuPos.left} top={actionMenuPos.top} />
        )}
      </div>

      {/* Centered top contextual toolbar (anchored to viewport). */}
      <TopContextualToolbar />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Edge labels (Bleed + Safe dimensions)                               */
/* ------------------------------------------------------------------ */

function CanvasLabels({
  lengthMm,
  widthMm,
  stagePx,
}: {
  lengthMm: number;
  widthMm: number;
  stagePx: number;
}) {
  // Bleed is the master rectangle; safe is 2mm in on each side.
  const bleedWPx = ((lengthMm * MM_TO_PX) / VIRTUAL_SIZE) * stagePx;
  const bleedHPx = ((widthMm * MM_TO_PX) / VIRTUAL_SIZE) * stagePx;
  const cx = stagePx / 2;
  const cy = stagePx / 2;
  const safeLength = Math.max(0, lengthMm - SAFETY_MM * 2);
  const safeWidth = Math.max(0, widthMm - SAFETY_MM * 2);

  return (
    <>
      {/* Top edge: bleed (master) dimensions */}
      <div
        className="absolute text-[11px] text-vp-muted whitespace-nowrap pointer-events-none"
        style={{
          left: cx,
          top: cy - bleedHPx / 2 - 22,
          transform: "translateX(-50%)",
        }}
      >
        Bleed: {lengthMm} × {widthMm} mm
      </div>
      {/* Bottom edge: safe area dimensions */}
      <div
        className="absolute text-[11px] text-vp-safety whitespace-nowrap pointer-events-none"
        style={{
          left: cx,
          top: cy + bleedHPx / 2 + 8,
          transform: "translateX(-50%)",
        }}
      >
        Safe: {safeLength} × {safeWidth} mm
      </div>

      {/* Left edge: width label (rotated) */}
      <div
        className="absolute text-[11px] text-vp-muted whitespace-nowrap pointer-events-none"
        style={{
          left: cx - bleedWPx / 2 - 12,
          top: cy,
          transform: "translate(-100%, -50%) rotate(-90deg)",
          transformOrigin: "right center",
        }}
      >
        {widthMm} mm
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Module-scoped history accessor                                      */
/*                                                                     */
/* The HistoryManager lives inside Workspace's lifecycle, but TopBar   */
/* (and keyboard shortcuts) need to drive undo/redo from outside. We   */
/* expose a tiny module-scoped registry that Workspace populates on    */
/* mount. This keeps the API simple without putting a non-serialisable */
/* class instance into Zustand state.                                  */
/* ------------------------------------------------------------------ */

let _historyManager: HistoryManager | null = null;

export function _registerHistory(h: HistoryManager | null) {
  _historyManager = h;
}

export const history = {
  undo: () => _historyManager?.undo(),
  redo: () => _historyManager?.redo(),
};
