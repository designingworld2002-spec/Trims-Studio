import { useEffect, useRef, useState, useCallback } from "react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import type { CanvasShape, ShapeModifiers } from "@/store/canvasStore";
import { HistoryManager } from "@/lib/history";
import { _registerHistory, history } from "@/lib/historyAccessor";
import { Autosave, loadSavedDesign, syncWorkIdToUrl } from "@/lib/autosave";
import { useSmartGuides } from "@/lib/useSmartGuides";
import { TopContextualToolbar } from "./TopContextualToolbar";
import { ObjectActionMenu } from "./ObjectActionMenu";
import { RevertToTemplate } from "./RevertToTemplate";
import { SideToggle } from "./SideToggle";

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
  holePunch: "holePunch",
} as const;

/* ------------------------------------------------------------------ */
/* Guide layer                                                         */
/* ------------------------------------------------------------------ */

interface GuideRects {
  bleed: fabric.Object;
  safety: fabric.Object;
  bleedLeft: number;
  bleedTop: number;
  bleedW: number;
  bleedH: number;
  safetyLeft: number;
  safetyTop: number;
  safetyW: number;
  safetyH: number;
  /** Silhouette shape this guide set was drawn with. */
  shape: CanvasShape;
  /** Tag orientation at draw time — drives which corners are modified. */
  tagOrientation: "vertical" | "horizontal";
  /**
   * Bleed-shape pixel measurements (driven by the active store modifiers).
   * Used downstream by `buildSafeAreaClip`, the texture overlay, and the
   * label brackets.
   */
  modifiers: ShapeModifiers;
  /** Convenience: corner radius applied to the BLEED rounded-rect, px. */
  bleedCornerRadiusPx: number;
  /** Convenience: chamfer (slant) applied to the BLEED cut-corners, px. */
  bleedSlantPx: number;
  /** Same fields but for the SAFETY shape (proportional inset). */
  safetyCornerRadiusPx: number;
  safetySlantPx: number;
}

/** Bleed-vs-safety inset (mm). The safety silhouette mirrors the bleed
 *  nested exactly SAFETY_MM inward on every edge. */
const SAFETY_INSET_MM = SAFETY_MM;

/* ------------------------------------------------------------------ */
/* Shape geometry — pure math, no fabric dependency                    */
/* ------------------------------------------------------------------ */

/**
 * Cut-corner polygon points. `slant` is the chamfer depth measured along
 * each edge from the corner inward.
 *
 * `cornersMode === 'all'` always chamfers all four corners.
 * `cornersMode === 'top'` chamfers only the two corners adjacent to the
 * tag's MODIFIED edge — the edge that carries the hole punch. Which
 * edge that is depends on `tagOrientation`:
 *   - vertical   → TL + TR (hole on top)
 *   - horizontal → TR + BR (hole on right)
 */
function cutCornerPoints(
  left: number,
  top: number,
  w: number,
  h: number,
  slant: number,
  cornersMode: "top" | "all",
  tagOrientation: "vertical" | "horizontal"
): { x: number; y: number }[] {
  const c = Math.max(0, Math.min(slant, w * 0.4, h * 0.4));
  if (cornersMode === "all") {
    return [
      { x: left + c, y: top },
      { x: left + w - c, y: top },
      { x: left + w, y: top + c },
      { x: left + w, y: top + h - c },
      { x: left + w - c, y: top + h },
      { x: left + c, y: top + h },
      { x: left, y: top + h - c },
      { x: left, y: top + c },
    ];
  }
  if (tagOrientation === "horizontal") {
    // TR + BR chamfered, TL + BL square. 6 vertices.
    return [
      { x: left, y: top },
      { x: left + w - c, y: top },
      { x: left + w, y: top + c },
      { x: left + w, y: top + h - c },
      { x: left + w - c, y: top + h },
      { x: left, y: top + h },
    ];
  }
  // vertical — TL + TR chamfered, BL + BR square.
  return [
    { x: left + c, y: top },
    { x: left + w - c, y: top },
    { x: left + w, y: top + c },
    { x: left + w, y: top + h },
    { x: left, y: top + h },
    { x: left, y: top + c },
  ];
}

/**
 * SVG path data for a rectangle with arcs only on the two corners
 * adjacent to the tag's modified edge.
 *   - vertical   → TL + TR rounded (BL + BR square)
 *   - horizontal → TR + BR rounded (TL + BL square)
 * Coordinates are absolute.
 */
function modifiedEdgeRoundedRectPath(
  left: number,
  top: number,
  w: number,
  h: number,
  r: number,
  tagOrientation: "vertical" | "horizontal"
): string {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  const L = left;
  const T = top;
  const R = left + w;
  const B = top + h;
  if (tagOrientation === "horizontal") {
    // TR + BR arcs, left edge square.
    return [
      `M ${L} ${T}`,
      `L ${R - radius} ${T}`,
      `A ${radius} ${radius} 0 0 1 ${R} ${T + radius}`,
      `L ${R} ${B - radius}`,
      `A ${radius} ${radius} 0 0 1 ${R - radius} ${B}`,
      `L ${L} ${B}`,
      "Z",
    ].join(" ");
  }
  // vertical — TL + TR arcs, bottom edge square.
  return [
    `M ${L + radius} ${T}`,
    `L ${R - radius} ${T}`,
    `A ${radius} ${radius} 0 0 1 ${R} ${T + radius}`,
    `L ${R} ${B}`,
    `L ${L} ${B}`,
    `L ${L} ${T + radius}`,
    `A ${radius} ${radius} 0 0 1 ${L + radius} ${T}`,
    "Z",
  ].join(" ");
}

/**
 * Star polygon vertices. Alternates between outer and inner radii to build
 * a `points`-pointed star. Center is the bounding-box centre; radii fit the
 * bounding box.
 */
function starPoints(
  left: number,
  top: number,
  w: number,
  h: number,
  points: number
): { x: number; y: number }[] {
  const cx = left + w / 2;
  const cy = top + h / 2;
  const outerX = w / 2;
  const outerY = h / 2;
  // Inner radius at ~38% of the outer — classic 5-point star proportion.
  const innerScale = 0.38;
  const n = Math.max(5, Math.floor(points));
  const total = n * 2;
  const out: { x: number; y: number }[] = [];
  // Start at "12 o'clock" so the first point reads upward.
  const start = -Math.PI / 2;
  for (let i = 0; i < total; i++) {
    const a = start + (i * Math.PI) / n;
    const rx = i % 2 === 0 ? outerX : outerX * innerScale;
    const ry = i % 2 === 0 ? outerY : outerY * innerScale;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

/**
 * Build a guide silhouette (bleed or safety) for the active shape.
 * Returns a fabric.Object positioned in absolute canvas coordinates.
 *   - rectangle      → fabric.Rect
 *   - round-corners  → fabric.Rect with dynamic rx / ry
 *   - cut-corners    → fabric.Polygon (all four corners chamfered)
 *   - oval           → fabric.Ellipse fitting the w×h box
 *   - star           → fabric.Polygon (alternating outer/inner radii)
 */
/**
 * SVG path data for a SCALLOPED rectangle — a quarter-circle CUT OUT of
 * each of the 4 corners (concave arcs, sweep-flag 0). Coords are local
 * (0..w / 0..h); caller positions via fabric's `left`/`top`.
 */
function scallopedPath(w: number, h: number, r: number): string {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M ${rad} 0`,
    `L ${w - rad} 0`,
    `A ${rad} ${rad} 0 0 0 ${w} ${rad}`,
    `L ${w} ${h - rad}`,
    `A ${rad} ${rad} 0 0 0 ${w - rad} ${h}`,
    `L ${rad} ${h}`,
    `A ${rad} ${rad} 0 0 0 0 ${h - rad}`,
    `L 0 ${rad}`,
    `A ${rad} ${rad} 0 0 0 ${rad} 0`,
    "Z",
  ].join(" ");
}

/**
 * Points (absolute canvas coords) for a POINTED-TOP tag — triangular
 * apex on the top edge, square bottom. `pointHeight` is the depth of
 * the triangular point in px (clamped to half the shorter axis).
 */
function pointedTopPoints(
  left: number,
  top: number,
  w: number,
  h: number,
  pointHeight: number
): { x: number; y: number }[] {
  const p = Math.max(0, Math.min(pointHeight, w * 0.5, h * 0.45));
  return [
    { x: left + w / 2, y: top }, // apex
    { x: left + w, y: top + p }, // top-right after the slope
    { x: left + w, y: top + h }, // bottom-right
    { x: left, y: top + h }, // bottom-left
    { x: left, y: top + p }, // top-left after the slope
  ];
}

/**
 * Points for a HEXAGON-POINTED tag — single apex on top AND bottom,
 * straight vertical sides. `pointHeight` controls the depth of BOTH
 * apex triangles.
 */
function hexagonPointedPoints(
  left: number,
  top: number,
  w: number,
  h: number,
  pointHeight: number
): { x: number; y: number }[] {
  const p = Math.max(0, Math.min(pointHeight, w * 0.5, h * 0.4));
  return [
    { x: left + w / 2, y: top }, // top apex
    { x: left + w, y: top + p },
    { x: left + w, y: top + h - p },
    { x: left + w / 2, y: top + h }, // bottom apex
    { x: left, y: top + h - p },
    { x: left, y: top + p },
  ];
}

/**
 * SVG path data for a FLARED tag — top + bottom edges straight, left
 * and right sides curve INWARD (concave waist). `waist` is the maximum
 * horizontal inset at the midpoint of each vertical side.
 */
function flaredPath(w: number, h: number, waist: number): string {
  const d = Math.max(0, Math.min(waist, w * 0.35));
  return [
    `M 0 0`,
    `L ${w} 0`,
    // Right side curves inward via quadratic Bezier with control point
    // pulled toward the centre of the shape.
    `Q ${w - d} ${h / 2} ${w} ${h}`,
    `L 0 ${h}`,
    // Left side mirrors.
    `Q ${d} ${h / 2} 0 0`,
    "Z",
  ].join(" ");
}

/**
 * SVG path data for a MIXED-CUT-ROUND tag — angled cut on the TOP two
 * corners (like cut-corners) + rounded arc on the BOTTOM two corners
 * (like round-corners). Single `corner` value drives both so the slant
 * length matches the bottom radius for a balanced silhouette.
 */
function mixedCutRoundPath(w: number, h: number, corner: number): string {
  const c = Math.max(0, Math.min(corner, w * 0.4, h * 0.4));
  return [
    `M ${c} 0`,
    `L ${w - c} 0`,
    `L ${w} ${c}`, // angled cut top-right
    `L ${w} ${h - c}`,
    `A ${c} ${c} 0 0 1 ${w - c} ${h}`, // rounded bottom-right
    `L ${c} ${h}`,
    `A ${c} ${c} 0 0 1 0 ${h - c}`, // rounded bottom-left
    `L 0 ${c}`,
    `L ${c} 0`, // angled cut top-left
    "Z",
  ].join(" ");
}

function makeGuideShape(
  shape: CanvasShape,
  left: number,
  top: number,
  w: number,
  h: number,
  opts: {
    cornerRadiusPx: number;
    slantPx: number;
    starPoints: number;
    cornersMode: "top" | "all";
    tagOrientation: "vertical" | "horizontal";
  },
  style: fabric.IObjectOptions
): fabric.Object {
  switch (shape) {
    case "round-corners": {
      const r = Math.max(0, Math.min(opts.cornerRadiusPx, w / 2, h / 2));
      if (opts.cornersMode === "top") {
        // Custom SVG path — only the corners adjacent to the modified
        // edge are arced. Build with origin (0,0) and position via
        // left/top so fabric's bbox math lines up with the bleed.
        const d = modifiedEdgeRoundedRectPath(
          0,
          0,
          w,
          h,
          r,
          opts.tagOrientation
        );
        return new fabric.Path(d, {
          left,
          top,
          ...style,
        });
      }
      return new fabric.Rect({
        left,
        top,
        width: w,
        height: h,
        rx: r,
        ry: r,
        ...style,
      });
    }
    case "cut-corners":
      return new fabric.Polygon(
        cutCornerPoints(
          left,
          top,
          w,
          h,
          opts.slantPx,
          opts.cornersMode,
          opts.tagOrientation
        ),
        { ...style }
      );
    case "oval":
      return new fabric.Ellipse({
        left,
        top,
        rx: w / 2,
        ry: h / 2,
        ...style,
      });
    case "star":
      return new fabric.Polygon(
        starPoints(left, top, w, h, opts.starPoints),
        { ...style }
      );
    case "scalloped": {
      const r = Math.max(0, Math.min(opts.cornerRadiusPx, w / 2, h / 2));
      return new fabric.Path(scallopedPath(w, h, r), {
        left,
        top,
        ...style,
      });
    }
    case "pointed-top":
      return new fabric.Polygon(
        pointedTopPoints(left, top, w, h, opts.slantPx),
        { ...style }
      );
    case "hexagon-pointed":
      return new fabric.Polygon(
        hexagonPointedPoints(left, top, w, h, opts.slantPx),
        { ...style }
      );
    case "flared":
      return new fabric.Path(flaredPath(w, h, opts.slantPx), {
        left,
        top,
        ...style,
      });
    case "mixed-cut-round":
      return new fabric.Path(mixedCutRoundPath(w, h, opts.slantPx), {
        left,
        top,
        ...style,
      });
    case "rectangle":
    default:
      return new fabric.Rect({ left, top, width: w, height: h, ...style });
  }
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
  // Pause history while we mutate guides. Without this we hit a recursive
  // duplication bug:
  //   drawGuides cleanup → object:removed event → history snapshot →
  //   onChange sees no guides → calls drawGuides again → both drawGuides
  //   calls add a pair → 4 guides on canvas.
  // Pausing means the cleanup events don't trigger the recursive callback.
  const wasPaused = history.isPaused();
  if (!wasPaused) history.pause();

  // Wipe existing guides (HMR, undo restores, dim changes).
  const stale = canvas.getObjects().filter((o) => {
    const id = (o as any).id;
    return (
      id === GUIDE_IDS.bleed ||
      id === GUIDE_IDS.safety ||
      id === GUIDE_IDS.holePunch
    );
  });
  if (stale.length > 0) canvas.remove(...stale);

  // X axis = length, Y axis = width. Bleed dimensions come straight from
  // the store — they are the master size.
  const bleedW = lengthMm * MM_TO_PX;
  const bleedH = widthMm * MM_TO_PX;
  const safetyW = Math.max(1, bleedW - SAFETY_INSET_MM * 2 * MM_TO_PX);
  const safetyH = Math.max(1, bleedH - SAFETY_INSET_MM * 2 * MM_TO_PX);

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

  // Resolve the active shape + measurement modifiers from the store.
  // These are dynamic now — the Product panel can flip them at any moment.
  const store = useCanvasStore.getState();
  const shape: CanvasShape = store.canvasShape;
  const modifiers: ShapeModifiers = store.shapeModifiers;
  const tagOrientation: "vertical" | "horizontal" = store.tagOrientation;

  // The shortest side caps every shape modifier at 40%.
  const shortEdgeMm = Math.max(1, Math.min(lengthMm, widthMm));
  const maxModifierMm = shortEdgeMm * 0.4;

  const bleedCornerRadiusMm = Math.max(
    0,
    Math.min(modifiers.cornerRadiusMm, maxModifierMm)
  );
  const bleedSlantMm = Math.max(
    0,
    Math.min(modifiers.slantLengthMm, maxModifierMm)
  );
  // Safety shape nests SAFETY_INSET_MM inward → measurement modifiers
  // shrink by the same inset (clamped to 0).
  const safetyCornerRadiusMm = Math.max(
    0,
    bleedCornerRadiusMm - SAFETY_INSET_MM
  );
  const safetySlantMm = Math.max(0, bleedSlantMm - SAFETY_INSET_MM);

  const bleedCornerRadiusPx = bleedCornerRadiusMm * MM_TO_PX;
  const bleedSlantPx = bleedSlantMm * MM_TO_PX;
  const safetyCornerRadiusPx = safetyCornerRadiusMm * MM_TO_PX;
  const safetySlantPx = safetySlantMm * MM_TO_PX;

  // 1) Bleed — the visible "card". Filled with the user's bg colour,
  //    SOLID sky-blue stroke (refined Vistaprint look), soft drop shadow.
  //    Shape-aware: rectangle / round / cut / oval / star.
  const bleed = makeGuideShape(
    shape,
    bleedLeft,
    bleedTop,
    bleedW,
    bleedH,
    {
      cornerRadiusPx: bleedCornerRadiusPx,
      slantPx: bleedSlantPx,
      starPoints: modifiers.starPoints,
      cornersMode: modifiers.cornersMode,
      tagOrientation,
    },
    {
      fill: bgFill,
      stroke: "#38bdf8",
      strokeWidth: 2,
      strokeUniform: true,
      shadow: new fabric.Shadow({
        color: "rgba(0,0,0,0.12)",
        blur: 24,
        offsetX: 0,
        offsetY: 4,
      }),
      ...baseProps,
    }
  );
  (bleed as any).id = GUIDE_IDS.bleed;
  Object.assign(bleed, baseAny);

  // 2) Safety — dashed green nested inside the bleed.
  const safety = makeGuideShape(
    shape,
    safetyLeft,
    safetyTop,
    safetyW,
    safetyH,
    {
      cornerRadiusPx: safetyCornerRadiusPx,
      slantPx: safetySlantPx,
      starPoints: modifiers.starPoints,
      cornersMode: modifiers.cornersMode,
      tagOrientation,
    },
    {
      fill: "transparent",
      stroke: "#22c55e",
      strokeWidth: 2,
      strokeDashArray: [8, 5],
      strokeUniform: true,
      ...baseProps,
    }
  );
  (safety as any).id = GUIDE_IDS.safety;
  Object.assign(safety, baseAny);

  canvas.add(bleed, safety);
  canvas.sendToBack(safety);
  canvas.sendToBack(bleed);

  // 3) Hole punch — product-driven protective overlay (e.g. hang tags).
  //    Centred horizontally, offset down from the bleed's TOP edge,
  //    dashed red ring with transparent fill. Strictly locked + excluded
  //    from export so it never lands in the saved JSON or the print PNG.
  //    Kept at the front so it's always a visible "don't place here" cue.
  const { visualGuides } = useCanvasStore.getState().productConfig;
  if (visualGuides.hasHolePunch && visualGuides.holePunchRadiusMm > 0) {
    const holeR = visualGuides.holePunchRadiusMm * MM_TO_PX;
    const holeOffsetPx = visualGuides.holePunchOffsetFromTopMm * MM_TO_PX;
    // Orientation-aware placement: vertical tags hang from the TOP edge,
    // horizontal tags hang from the RIGHT edge. The hole sits the same
    // offset inward from the hanging edge, and is centred across the
    // perpendicular axis.
    const holeCenterX =
      tagOrientation === "horizontal"
        ? bleedLeft + bleedW - holeOffsetPx
        : cx;
    const holeCenterY =
      tagOrientation === "horizontal" ? cy : bleedTop + holeOffsetPx;
    const hole = new fabric.Circle({
      radius: holeR,
      left: holeCenterX,
      top: holeCenterY,
      originX: "center",
      originY: "center",
      fill: "transparent",
      stroke: "#ef4444",
      strokeWidth: 2,
      strokeDashArray: [6, 4],
      strokeUniform: true,
      ...baseProps,
    });
    (hole as any).id = GUIDE_IDS.holePunch;
    Object.assign(hole, baseAny);
    canvas.add(hole);
    canvas.bringToFront(hole);
  }

  canvas.requestRenderAll();

  // Restore history if WE paused it (don't unpause if our caller had it
  // already paused for its own bulk operation, e.g. loadFromJSON).
  if (!wasPaused) history.resume(false);

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
    shape,
    tagOrientation,
    modifiers,
    bleedCornerRadiusPx,
    bleedSlantPx,
    safetyCornerRadiusPx,
    safetySlantPx,
  };
}

/* ------------------------------------------------------------------ */
/* Strict masking — user objects clip to the safe area                 */
/* ------------------------------------------------------------------ */

/**
 * Build an `absolutePositioned` clipPath matching the SAFETY silhouette so
 * content is masked to the real tag shape (a cut-corner tag clips off the
 * top corners; a circle tag clips to the ellipse). Positioned in canvas
 * coordinates so it stays put even when the wrapped object moves.
 */
function buildSafeAreaClip(g: GuideRects): fabric.Object {
  const opts: fabric.IObjectOptions & Record<string, any> = {
    absolutePositioned: true,
  };
  const cornersMode = g.modifiers.cornersMode;
  switch (g.shape) {
    case "round-corners": {
      const r = Math.max(
        0,
        Math.min(g.safetyCornerRadiusPx, g.safetyW / 2, g.safetyH / 2)
      );
      if (cornersMode === "top") {
        const d = modifiedEdgeRoundedRectPath(
          0,
          0,
          g.safetyW,
          g.safetyH,
          r,
          g.tagOrientation
        );
        return new fabric.Path(d, {
          left: g.safetyLeft,
          top: g.safetyTop,
          ...opts,
        });
      }
      return new fabric.Rect({
        left: g.safetyLeft,
        top: g.safetyTop,
        width: g.safetyW,
        height: g.safetyH,
        rx: r,
        ry: r,
        ...opts,
      });
    }
    case "cut-corners":
      return new fabric.Polygon(
        cutCornerPoints(
          g.safetyLeft,
          g.safetyTop,
          g.safetyW,
          g.safetyH,
          g.safetySlantPx,
          cornersMode,
          g.tagOrientation
        ),
        opts
      );
    case "oval":
      return new fabric.Ellipse({
        left: g.safetyLeft,
        top: g.safetyTop,
        rx: g.safetyW / 2,
        ry: g.safetyH / 2,
        ...opts,
      });
    case "star":
      return new fabric.Polygon(
        starPoints(
          g.safetyLeft,
          g.safetyTop,
          g.safetyW,
          g.safetyH,
          g.modifiers.starPoints
        ),
        opts
      );
    case "scalloped": {
      const r = Math.max(
        0,
        Math.min(g.safetyCornerRadiusPx, g.safetyW / 2, g.safetyH / 2)
      );
      return new fabric.Path(scallopedPath(g.safetyW, g.safetyH, r), {
        left: g.safetyLeft,
        top: g.safetyTop,
        ...opts,
      });
    }
    case "pointed-top":
      return new fabric.Polygon(
        pointedTopPoints(
          g.safetyLeft,
          g.safetyTop,
          g.safetyW,
          g.safetyH,
          g.safetySlantPx
        ),
        opts
      );
    case "hexagon-pointed":
      return new fabric.Polygon(
        hexagonPointedPoints(
          g.safetyLeft,
          g.safetyTop,
          g.safetyW,
          g.safetyH,
          g.safetySlantPx
        ),
        opts
      );
    case "flared":
      return new fabric.Path(
        flaredPath(g.safetyW, g.safetyH, g.safetySlantPx),
        {
          left: g.safetyLeft,
          top: g.safetyTop,
          ...opts,
        }
      );
    case "mixed-cut-round":
      return new fabric.Path(
        mixedCutRoundPath(g.safetyW, g.safetyH, g.safetySlantPx),
        {
          left: g.safetyLeft,
          top: g.safetyTop,
          ...opts,
        }
      );
    case "rectangle":
    default:
      return new fabric.Rect({
        left: g.safetyLeft,
        top: g.safetyTop,
        width: g.safetyW,
        height: g.safetyH,
        ...opts,
      });
  }
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
  tagTemplateBackground(canvas, lengthMm, widthMm);
  canvas.requestRenderAll();
}

/**
 * Identify the template's background rectangle and tag it `id: "templateBg"`.
 *
 * Most trims-style templates put a full-bleed coloured rect at the bottom of
 * the stack as the design's background. Without this tag the Background
 * panel's colour picker would change the bleed-rect fill underneath, which
 * the template covers — so the user would see no change. By tagging the
 * template's own background we can route colour changes to it directly.
 *
 * Heuristic: the bottom-most user object that's a fillable shape and whose
 * post-fit bounding rect covers ≥ 80 % of the bleed area.
 */
function tagTemplateBackground(
  canvas: fabric.Canvas,
  lengthMm: number,
  widthMm: number
) {
  const bleedArea = lengthMm * MM_TO_PX * widthMm * MM_TO_PX;
  const userObjs = canvas
    .getObjects()
    .filter((o) => !(o as any).excludeFromExport);
  // First user object in z-order is the bottom of the stack.
  for (const obj of userObjs) {
    const t = obj.type ?? "";
    if (t !== "rect" && t !== "polygon" && t !== "path") continue;
    const fill = (obj as any).fill;
    if (!fill || fill === "transparent") continue;
    const br = obj.getBoundingRect(true, true);
    const coverage = (br.width * br.height) / bleedArea;
    if (coverage >= 0.8) {
      (obj as any).id = "templateBg";
      // Sync the Background panel's current colour to whatever the
      // template ships, so the colour picker shows the right swatch the
      // first time the user opens the panel.
      if (typeof fill === "string") {
        const store = useCanvasStore.getState();
        // Update the store field WITHOUT re-running setBackgroundColor's
        // canvas mutation — we'd just re-paint the same colour we read.
        useCanvasStore.setState({ backgroundColor: fill });
        // Also keep the bleed rect coherent — it's the fallback if the
        // user later deletes the template's background.
        const bleed = canvas
          .getObjects()
          .find((o) => (o as any).id === "bleed");
        if (bleed) bleed.set("fill", fill);
        void store; // silence unused-var if logging is removed
      }
      return;
    }
    // Only consider the literal bottom object — if it's not a coverage rect,
    // there's no template background to repurpose.
    return;
  }
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
  const previewMode = useCanvasStore((s) => s.previewMode);
  const productConfig = useCanvasStore((s) => s.productConfig);
  const canvasShape = useCanvasStore((s) => s.canvasShape);
  const shapeModifiers = useCanvasStore((s) => s.shapeModifiers);
  const tagOrientation = useCanvasStore((s) => s.tagOrientation);

  // Smart alignment guides (snap-to-edge / snap-to-centre while dragging).
  // Reads `canvas` from the store so it activates as soon as the canvas
  // is mounted and tears down on unmount.
  useSmartGuides(useCanvasStore((s) => s.canvas));

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
      // Keep the protective hole-punch ring above newly-added user
      // content so it always reads as a "don't place here" warning.
      const hole = canvas
        .getObjects()
        .find((o) => (o as any).id === GUIDE_IDS.holePunch);
      if (hole) canvas.bringToFront(hole);
    });

    setCanvas(canvas);
    if (import.meta.env.DEV) {
      (window as any).__trimsCanvas = canvas;
      (window as any).__trimsStore = useCanvasStore;
      (window as any).__trimsHistory = history;
    }

    // Wire history.
    // NOTE: the callback receives the manager as an argument rather than
    // closing over the local `hist` binding — `new HistoryManager()` triggers
    // an initial snapshot synchronously inside the constructor, which would
    // hit a Temporal Dead Zone if we read `hist` from the closure before the
    // assignment completes.
    const hist = new HistoryManager({
      canvas,
      virtualSize: VIRTUAL_SIZE,
      store: {
        getDims: () => {
          const s = useCanvasStore.getState();
          return { lengthMm: s.canvasLengthMm, widthMm: s.canvasWidthMm };
        },
        getBackgroundColor: () =>
          useCanvasStore.getState().backgroundColor,
        setDimsForRestore: (lengthMm, widthMm) => {
          // We're applying a snapshot — object positions in the snapshot
          // are ALREADY valid for these dims. Suppress the dim-effect's
          // auto-rescale so it doesn't apply a redundant scale on top.
          const s = useCanvasStore.getState();
          s._setSkipNextDimRescale(true);
          s.setCanvasSize(lengthMm, widthMm);
        },
        setBackgroundColorForRestore: (c) => {
          // Use setState directly so we don't recurse into `commit()`.
          useCanvasStore.setState({ backgroundColor: c });
          // Also propagate the colour to the bleed/templateBg rects on
          // the canvas. setBackgroundColor would commit() a snapshot
          // and we don't want that mid-restore.
          const bleed = canvas
            .getObjects()
            .find((o) => (o as any).id === "bleed");
          if (bleed) bleed.set("fill", c);
          const tplBg = canvas
            .getObjects()
            .find((o) => (o as any).id === "templateBg");
          if (tplBg) tplBg.set("fill", c);
        },
      },
      onChange: (mgr) => {
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
      },
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

    // designOps facade — load arbitrary fabric JSON onto the live canvas
    // (Recent Designs picker) or wipe every user object (Clear canvas).
    _registerDesignOps({
      loadJson: (json, lengthMm, widthMm) =>
        new Promise<void>((resolve) => {
          hist.pause();

          // 0) Pre-load cleanup. `canvas.loadFromJSON` calls
          //    `canvas.clear()` internally so every existing object is
          //    removed, but we ALSO need to wipe the canvas-level
          //    background colour and the store's `backgroundColor`. If
          //    we don't, the previously-set colour bleeds through to
          //    the next design — the user reported a yellow card
          //    persisting after switching templates.
          canvas.setBackgroundColor(
            "" as any,
            canvas.renderAll.bind(canvas)
          );
          // Also explicitly remove any pre-existing templateBg-tagged
          // rect (belt-and-suspenders — clear() handles it, but if a
          // future change introduces an out-of-band path we don't want
          // a stale background lingering).
          canvas
            .getObjects()
            .filter((o) => (o as any).id === "templateBg")
            .forEach((o) => canvas.remove(o));

          canvas.loadFromJSON(json, () => {
            // 1) Reset the canvas surface — virtual stage size, transparent
            //    bg (the bleed rect carries the visible colour), 1:1 vp.
            if (
              canvas.width !== VIRTUAL_SIZE ||
              canvas.height !== VIRTUAL_SIZE
            ) {
              canvas.setDimensions({
                width: VIRTUAL_SIZE,
                height: VIRTUAL_SIZE,
              });
            }
            // 1b) Capture the LOADED design's native background colour
            //     BEFORE we wipe `canvas.backgroundColor` to transparent.
            //
            //     Priority (high → low):
            //       1) `templateBg` rect's fill (the saved design's
            //          tagged background layer, if any)
            //       2) `canvas.backgroundColor` (fabric's loadFromJSON
            //          restores this from the JSON's top-level
            //          `background` field)
            //       3) White, only as a last resort
            //
            //     This makes a switched-to template adopt its native
            //     colour instead of forcing white on every load.
            const loadedTplBg = canvas
              .getObjects()
              .find((o) => (o as any).id === "templateBg");
            const tplBgFill =
              loadedTplBg && typeof (loadedTplBg as any).fill === "string"
                ? ((loadedTplBg as any).fill as string)
                : null;
            const canvasJsonBg =
              typeof canvas.backgroundColor === "string" &&
              canvas.backgroundColor &&
              canvas.backgroundColor !== "transparent"
                ? canvas.backgroundColor
                : null;
            const newBgColor = tplBgFill ?? canvasJsonBg ?? "#ffffff";

            canvas.backgroundColor = "transparent";
            canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
            // Apply the resolved colour to the store + propagate to the
            // bleed rect (which is what the user actually sees).
            useCanvasStore.setState({ backgroundColor: newBgColor });

            // 2) Fit-to-bounding-box scaling.
            //
            // Compute the union bounding box of every loaded user object
            // (excluding any excludeFromExport guides that snuck in).
            // Compare against the target bleed area for the new
            // workspace and uniformly scale + center so the composition
            // exactly fills the bleed (Math.min preserves aspect → no
            // overflow, no distortion).
            const userObjects = canvas
              .getObjects()
              .filter((o) => !(o as any).excludeFromExport);

            if (userObjects.length > 0) {
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
              const oldW = Math.max(1, maxX - minX);
              const oldH = Math.max(1, maxY - minY);
              const newW = lengthMm * MM_TO_PX;
              const newH = widthMm * MM_TO_PX;
              const scaleFactor = Math.min(newW / oldW, newH / oldH);
              const oldCenterX = (minX + maxX) / 2;
              const oldCenterY = (minY + maxY) / 2;
              const cx = VIRTUAL_SIZE / 2;
              const cy = VIRTUAL_SIZE / 2;

              userObjects.forEach((o) => {
                o.scaleX = (o.scaleX ?? 1) * scaleFactor;
                o.scaleY = (o.scaleY ?? 1) * scaleFactor;
                o.left = cx + ((o.left ?? 0) - oldCenterX) * scaleFactor;
                o.top = cy + ((o.top ?? 0) - oldCenterY) * scaleFactor;
                // setCoords so selection handles + raycasting line up
                // with the new geometry (without this, click-targets
                // stay in the pre-scale positions).
                o.setCoords();
              });
            }

            // 3) Push the new dims into the store. We've already done the
            //    fit-to-bleed math above, so flag the dim-change effect
            //    to skip its auto-rescale — otherwise it would scale
            //    on top of our scale and shrink everything.
            const store = useCanvasStore.getState();
            if (
              store.canvasLengthMm === lengthMm &&
              store.canvasWidthMm === widthMm
            ) {
              // Dims unchanged → dim-effect won't fire. Redraw guides
              // + reapply clips directly. Use `newBgColor` (the loaded
              // design's actual colour), NOT `store.backgroundColor`
              // — the store may still hold the previous design's value
              // because React hasn't flushed our `setState` above yet.
              guidesRef.current = drawGuides(
                canvas,
                lengthMm,
                widthMm,
                newBgColor
              );
              applySafeAreaClipToAllObjects(canvas, guidesRef.current);
            } else {
              store._setSkipNextDimRescale(true);
              store.setCanvasSize(lengthMm, widthMm);
            }

            // 4) Force a clean render and let history take ONE snapshot
            //    so this loaded design is the new "fresh" undo baseline.
            canvas.requestRenderAll();
            hist.resume(true);
            resolve();
          });
        }),
      clearAll: () => {
        hist.pause();
        canvas
          .getObjects()
          .filter((o) => !(o as any).excludeFromExport)
          .forEach((o) => canvas.remove(o));
        canvas.discardActiveObject();
        canvas.requestRenderAll();
        hist.resume(true);
      },
      redrawGuides: () => {
        // Pulls every guide input fresh from the store — bypasses React
        // effect batching so load / side-switch flows can guarantee a
        // redraw after their atomic state updates.
        const s = useCanvasStore.getState();
        hist.pause();
        guidesRef.current = drawGuides(
          canvas,
          s.canvasLengthMm,
          s.canvasWidthMm,
          s.backgroundColor
        );
        applySafeAreaClipToAllObjects(canvas, guidesRef.current);
        canvas.requestRenderAll();
        hist.resume(false);
      },
    });

    return () => {
      _registerHistory(null);
      _registerDesignOps(null);
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
   * When the bleed dimensions change in the Product Options panel, every
   * existing user object is rescaled so its layout tracks the new bleed
   * exactly — no drift, no compounding loss across many small steps.
   *
   * Why **per-axis** scaling (instead of a single Math.min/Math.max ratio):
   *
   *   With aspect lock ON, going 120 → 119 mm of length re-derives width
   *   to round(119 / 1.714) = 69 mm. The bleed shrinks by 119/120 = 0.9917
   *   on X and 69/70 = 0.9857 on Y. A single uniform scale of Math.min
   *   (= 0.9857) leaves the design ~7 px short of the bleed on X. Iterate
   *   that across 60+ key presses (down then up) and the design ends up
   *   visibly smaller than the safe area — the bug the user reported.
   *
   *   Scaling each object's left/top + scaleX/scaleY by the **per-axis**
   *   bleed ratio makes the design track the bleed exactly on every step.
   *   For aspect-locked changes scaleX === scaleY (no distortion). For
   *   unlocked changes the design stretches with the bleed, which is the
   *   correct behaviour: the user explicitly changed the aspect ratio.
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

    // designOps.loadJson sets `_skipNextDimRescale` because the loaded
    // objects are already at coordinates valid for the target bleed (it
    // ran its own fit-to-bleed math). Letting the auto-rescale fire here
    // would double-shrink them. Consume the flag (set it false) and
    // skip the rescale on this single pass.
    const skipRescale = useCanvasStore.getState()._skipNextDimRescale;
    if (skipRescale) {
      useCanvasStore.getState()._setSkipNextDimRescale(false);
    }

    let didProgrammaticChange = false;
    if (!skipRescale && dimsChanged && prev.length > 0 && prev.width > 0) {
      const scaleX = lengthMm / prev.length;
      const scaleY = widthMm / prev.width;
      const shouldRescale =
        scaleX > 0 && scaleY > 0 && (scaleX !== 1 || scaleY !== 1);
      if (shouldRescale) {
        const cx = VIRTUAL_SIZE / 2;
        const cy = VIRTUAL_SIZE / 2;
        const hist = historyRef.current;
        hist?.pause();
        canvas.getObjects().forEach((o) => {
          if ((o as any).excludeFromExport) return;
          o.scaleX = (o.scaleX ?? 1) * scaleX;
          o.scaleY = (o.scaleY ?? 1) * scaleY;
          o.left = cx + ((o.left ?? 0) - cx) * scaleX;
          o.top = cy + ((o.top ?? 0) - cy) * scaleY;
          o.setCoords();
        });
        hist?.resume(false);
        didProgrammaticChange = true;
      }
    }
    prevDimsRef.current = { length: lengthMm, width: widthMm };

    guidesRef.current = drawGuides(canvas, lengthMm, widthMm, backgroundColor);
    // Re-apply the safe-area mask to every existing user object — when the
    // safety rect resizes, every clipPath needs to follow.
    applySafeAreaClipToAllObjects(canvas, guidesRef.current);

    // Commit ONE clean snapshot after the rescale + guide redraw is done,
    // so the dimension change is undoable. Skipped during loadJson /
    // history restore (the skip flag is on) since those paths take their
    // own snapshot at the right moment.
    if (didProgrammaticChange) {
      history.commit();
    }
  }, [
    lengthMm,
    widthMm,
    backgroundColor,
    canvasShape,
    shapeModifiers,
    tagOrientation,
  ]);

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

  // (No scroll-centering effect needed — we're back to a static
  // overflow-hidden workspace with center-anchored CSS scaling, so
  // zooming naturally radiates from the canvas center without any
  // browser scrollbar shifting things around.)

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

  // "Stable" workspace flag — falls to false on any zoom or
  // dimension/orientation change, then re-stabilises after a short
  // debounce. The rotate FAB hides while transitioning so it doesn't
  // glitch against the moving rulers / bleed.
  const [isStable, setIsStable] = useState(true);
  useEffect(() => {
    setIsStable(false);
    const t = window.setTimeout(() => setIsStable(true), 380);
    return () => window.clearTimeout(t);
  }, [zoom, fitScale, lengthMm, widthMm, tagOrientation]);

  return (
    /*
     * Static, premium-feel workspace.
     *
     * `overflow-hidden` (no browser scrollbars) plus flex centering keeps
     * the stage anchored to the middle of the work area at every zoom.
     * The canvas itself is rendered at the virtual resolution and scaled
     * with `transform-origin: center center`, so zooming radiates
     * outward without ever shifting top-left or right-bottom.
     */
    <div
      ref={containerRef}
      className="relative w-full h-full flex items-center justify-center overflow-hidden"
    >
      <div
        ref={stageRef}
        className="relative shrink-0"
        style={{
          width: stagePxSize,
          height: stagePxSize,
        }}
      >
        {/* Canvas itself: virtual resolution, scaled from CENTER. */}
        <div
          className="absolute vp-canvas-shadow"
          style={{
            width: VIRTUAL_SIZE,
            height: VIRTUAL_SIZE,
            top: "50%",
            left: "50%",
            transform: `translate(-50%, -50%) scale(${totalScale})`,
            transformOrigin: "center center",
          }}
        >
          <canvas ref={canvasElRef} />
          {/* PREVIEW MODE — material texture clipped EXACTLY to the bleed
              rectangle. Positioned in virtual canvas coords (since this
              parent is the VIRTUAL_SIZE stage), so it scales together
              with the canvas via the parent transform. Shape-aware
              clip-path keeps the texture inside cut-corners / ovals /
              round-corners / stars. */}
          {previewMode && productConfig.textureOverlayCss && (
            <BleedTextureOverlay
              lengthMm={lengthMm}
              widthMm={widthMm}
              shape={canvasShape}
              modifiers={shapeModifiers}
              tagOrientation={tagOrientation}
              backgroundCss={productConfig.textureOverlayCss}
              backgroundSize={getTextureSize(productConfig.handle)}
              blendMode={productConfig.textureOverlayBlendMode}
              opacity={productConfig.textureOverlayOpacity}
            />
          )}
        </div>

        {/* External labels for Bleed + Safe dimensions. Hidden in
            preview mode so the canvas reads as a finished, untouchable
            preview. */}
        {!previewMode && (
          <CanvasLabels
            lengthMm={lengthMm}
            widthMm={widthMm}
            stagePx={stagePxSize}
            shape={canvasShape}
            modifiers={shapeModifiers}
          />
        )}

        {/* Floating per-object actions. */}
        {!previewMode && actionMenuPos.visible && (
          <ObjectActionMenu left={actionMenuPos.left} top={actionMenuPos.top} />
        )}

        {/* Canvas-rotate button (hang-tags only). Sits inside the stage
            at the ruler intersection so it scales with canvas zoom.
            Fades out while the workspace is transitioning (zoom or
            rotation) and fades back in once the layout settles. */}
        {!previewMode && (
          <CanvasRotateButton
            lengthMm={lengthMm}
            widthMm={widthMm}
            stagePx={stagePxSize}
            isStable={isStable}
          />
        )}
      </div>

      {/* Centered top contextual toolbar (anchored to viewport). */}
      {!previewMode && <TopContextualToolbar />}

      {/* Pill that appears only when a design has been loaded from the
          Recent Designs picker. */}
      <RevertToTemplate />

      {/* Floating Front / Back side switcher (multi-sided products). */}
      <SideToggle />

      {/* PREVIEW MODE — floating "Exit preview" pill so the user can
          always get back to editing. */}
      {previewMode && <ExitPreviewPill />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Preview Mode helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Per-product texture tiling. Smaller cells = denser pattern (woven
 * thread). Bigger cells = softer organic feel (paper grain).
 */
function getTextureSize(handle: string): string {
  if (handle === "woven-labels") return "3px 3px";
  if (handle === "hang-tags") return "8px 8px, 12px 12px, 6px 6px, 4px 4px";
  return "auto";
}

/**
 * Preview-mode texture overlay. Positioned in virtual canvas coordinates
 * exactly over the BLEED rectangle, and clipped via CSS `clip-path` to
 * the active silhouette so the texture never spills past the product
 * edge (e.g. into the chamfered corners of a cut-corner tag).
 */
function BleedTextureOverlay({
  lengthMm,
  widthMm,
  shape,
  modifiers,
  tagOrientation,
  backgroundCss,
  backgroundSize,
  blendMode,
  opacity,
}: {
  lengthMm: number;
  widthMm: number;
  shape: CanvasShape;
  modifiers: ShapeModifiers;
  tagOrientation: "vertical" | "horizontal";
  backgroundCss: string;
  backgroundSize: string;
  blendMode: "multiply" | "overlay" | "soft-light" | "hard-light";
  opacity: number;
}) {
  const bleedW = lengthMm * MM_TO_PX;
  const bleedH = widthMm * MM_TO_PX;
  const left = VIRTUAL_SIZE / 2 - bleedW / 2;
  const top = VIRTUAL_SIZE / 2 - bleedH / 2;

  const shortEdgeMm = Math.max(1, Math.min(lengthMm, widthMm));
  const maxModifierMm = shortEdgeMm * 0.4;
  const radiusMm = Math.max(0, Math.min(modifiers.cornerRadiusMm, maxModifierMm));
  const slantMm = Math.max(0, Math.min(modifiers.slantLengthMm, maxModifierMm));
  const radiusPx = radiusMm * MM_TO_PX;
  const slantPx = slantMm * MM_TO_PX;

  // Build a CSS clip-path matching the bleed silhouette. The path is in
  // the overlay's local space (origin = top-left of the overlay div), so
  // every coord runs 0..bleedW / 0..bleedH.
  let clipPath: string | undefined;
  let borderRadius: string | undefined;
  const cornersMode = modifiers.cornersMode;
  const isHorizontal = tagOrientation === "horizontal";
  switch (shape) {
    case "round-corners":
      if (cornersMode === "top") {
        // Modified-edge rounded: vertical → top, horizontal → right.
        borderRadius = isHorizontal
          ? `0 ${radiusPx}px ${radiusPx}px 0`
          : `${radiusPx}px ${radiusPx}px 0 0`;
      } else {
        borderRadius = `${radiusPx}px`;
      }
      break;
    case "cut-corners": {
      const c = Math.max(0, Math.min(slantPx, bleedW * 0.4, bleedH * 0.4));
      if (cornersMode === "all") {
        clipPath = `polygon(${c}px 0, ${bleedW - c}px 0, ${bleedW}px ${c}px, ${bleedW}px ${bleedH - c}px, ${bleedW - c}px ${bleedH}px, ${c}px ${bleedH}px, 0 ${bleedH - c}px, 0 ${c}px)`;
      } else if (isHorizontal) {
        // TR + BR chamfered, left edge square.
        clipPath = `polygon(0 0, ${bleedW - c}px 0, ${bleedW}px ${c}px, ${bleedW}px ${bleedH - c}px, ${bleedW - c}px ${bleedH}px, 0 ${bleedH}px)`;
      } else {
        // TL + TR chamfered, bottom edge square.
        clipPath = `polygon(${c}px 0, ${bleedW - c}px 0, ${bleedW}px ${c}px, ${bleedW}px ${bleedH}px, 0 ${bleedH}px, 0 ${c}px)`;
      }
      break;
    }
    case "oval":
      borderRadius = "50%";
      break;
    case "star": {
      const pts = starPoints(0, 0, bleedW, bleedH, modifiers.starPoints)
        .map((p) => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`)
        .join(", ");
      clipPath = `polygon(${pts})`;
      break;
    }
    case "scalloped": {
      // CSS `clip-path: path()` mirrors the fabric SVG path exactly.
      clipPath = `path('${scallopedPath(bleedW, bleedH, radiusPx)}')`;
      break;
    }
    case "pointed-top": {
      const pts = pointedTopPoints(0, 0, bleedW, bleedH, slantPx)
        .map((p) => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`)
        .join(", ");
      clipPath = `polygon(${pts})`;
      break;
    }
    case "hexagon-pointed": {
      const pts = hexagonPointedPoints(0, 0, bleedW, bleedH, slantPx)
        .map((p) => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`)
        .join(", ");
      clipPath = `polygon(${pts})`;
      break;
    }
    case "flared":
      clipPath = `path('${flaredPath(bleedW, bleedH, slantPx)}')`;
      break;
    case "mixed-cut-round":
      clipPath = `path('${mixedCutRoundPath(bleedW, bleedH, slantPx)}')`;
      break;
    case "rectangle":
    default:
      break;
  }

  return (
    <div
      aria-hidden
      className="absolute pointer-events-none"
      style={{
        left,
        top,
        width: bleedW,
        height: bleedH,
        overflow: "hidden",
        background: backgroundCss,
        backgroundSize,
        mixBlendMode: blendMode,
        opacity,
        clipPath,
        borderRadius,
      }}
    />
  );
}

function ExitPreviewPill() {
  const setPreviewMode = useCanvasStore((s) => s.setPreviewMode);
  return (
    <button
      onClick={() => setPreviewMode(false)}
      className="absolute top-4 left-1/2 -translate-x-1/2 z-30 h-9 px-4 rounded-full bg-vp-accent text-white text-[12px] font-semibold tracking-wide shadow-vp-pop hover:opacity-90 transition-all"
    >
      Exit Preview
    </button>
  );
}

/**
 * Canvas-rotate button anchored at the bottom-left intersection of the
 * ruler lines. Placed INSIDE the zoomable stage so it scales naturally
 * with the canvas. Hang-tags only.
 *
 * `lengthMm` / `widthMm` / `stagePx` come from the parent so the corner
 * position matches CanvasLabels' rulers exactly (RULER_OFFSET = 14px).
 */
function CanvasRotateButton({
  lengthMm,
  widthMm,
  stagePx,
  isStable,
}: {
  lengthMm: number;
  widthMm: number;
  stagePx: number;
  isStable: boolean;
}) {
  const productHandle = useCanvasStore((s) => s.productConfig.handle);
  const toggleOrientation = useCanvasStore((s) => s.toggleOrientation);
  if (productHandle !== "hang-tags") return null;

  const bleedWPx = ((lengthMm * MM_TO_PX) / VIRTUAL_SIZE) * stagePx;
  const bleedHPx = ((widthMm * MM_TO_PX) / VIRTUAL_SIZE) * stagePx;
  const cx = stagePx / 2;
  const cy = stagePx / 2;
  // Same RULER_OFFSET as CanvasLabels — the button sits exactly where
  // the horizontal + vertical rulers meet.
  const RULER_OFFSET = 14;
  const cornerX = cx - bleedWPx / 2 - RULER_OFFSET;
  const cornerY = cy + bleedHPx / 2 + RULER_OFFSET;

  return (
    <button
      type="button"
      onClick={() => toggleOrientation()}
      aria-label="Rotate canvas 90°"
      title="Rotate canvas 90°"
      aria-hidden={!isStable}
      className="absolute z-20 w-9 h-9 rounded-full bg-white border border-black flex items-center justify-center text-black hover:bg-slate-50 active:scale-95"
      style={{
        left: cornerX,
        top: cornerY,
        transform: "translate(-50%, -50%)",
        opacity: isStable ? 1 : 0,
        pointerEvents: isStable ? "auto" : "none",
        transition: "opacity 220ms ease",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 12a9 9 0 1 1-3.51-7.13" />
        <polyline points="21 4 21 10 15 10" />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Edge labels (Bleed + Safe dimensions)                               */
/* ------------------------------------------------------------------ */

function CanvasLabels({
  lengthMm,
  widthMm,
  stagePx,
  shape,
  modifiers,
}: {
  lengthMm: number;
  widthMm: number;
  stagePx: number;
  shape: CanvasShape;
  modifiers: ShapeModifiers;
}) {
  // Bleed is the master rectangle; safe is 2mm in on each side.
  const bleedWPx = ((lengthMm * MM_TO_PX) / VIRTUAL_SIZE) * stagePx;
  const bleedHPx = ((widthMm * MM_TO_PX) / VIRTUAL_SIZE) * stagePx;
  const cx = stagePx / 2;
  const cy = stagePx / 2;

  // Display dimensions exactly as the store carries them — raw mm values
  // matching what the user typed in the Product Options panel.
  const lengthLabel = `${lengthMm} mm`;
  const widthLabel = `${widthMm} mm`;

  // Ruler offsets — how far OUTSIDE the bleed edge the ruler sits.
  const RULER_OFFSET = 14; // px from bleed edge to ruler line
  const TICK = 6; // half-length of the T-shaped end cap, px

  // Active modifier badge — appears alongside Safety / Bleed in a single
  // flex-wrap row so they NEVER overlap (badges flow to a second line on
  // very narrow bleeds instead of stacking on top of each other).
  const shortEdgeMm = Math.max(1, Math.min(lengthMm, widthMm));
  const maxModifierMm = Math.round(shortEdgeMm * 0.4);
  let modifierLabel: string | null = null;
  if (shape === "round-corners") {
    const v = Math.min(modifiers.cornerRadiusMm, maxModifierMm);
    modifierLabel = `R: ${v} mm`;
  } else if (shape === "cut-corners") {
    const v = Math.min(modifiers.slantLengthMm, maxModifierMm);
    modifierLabel = `Slant: ${v} mm`;
  } else if (shape === "star") {
    modifierLabel = `${modifiers.starPoints} pts`;
  } else if (shape === "scalloped") {
    const v = Math.min(modifiers.cornerRadiusMm, maxModifierMm);
    modifierLabel = `Scallop: ${v} mm`;
  } else if (shape === "pointed-top" || shape === "hexagon-pointed") {
    const v = Math.min(modifiers.slantLengthMm, maxModifierMm);
    modifierLabel = `Point: ${v} mm`;
  } else if (shape === "flared") {
    const v = Math.min(modifiers.slantLengthMm, maxModifierMm);
    modifierLabel = `Waist: ${v} mm`;
  } else if (shape === "mixed-cut-round") {
    const v = Math.min(modifiers.slantLengthMm, maxModifierMm);
    modifierLabel = `Corner: ${v} mm`;
  }

  return (
    <>
      {/* TOP-RIGHT BADGE STACK — Safety / Bleed / active shape modifier
          all flow inside a single flex-wrap row anchored to the bleed's
          top-right corner. flex-wrap guarantees no overlap on narrow
          bleeds (badges drop to a new line instead). */}
      <div
        className="absolute flex flex-wrap gap-2 justify-end pointer-events-none"
        style={{
          left: cx - bleedWPx / 2,
          top: cy - bleedHPx / 2 - 30,
          width: bleedWPx,
        }}
      >
        <span className="inline-flex items-center rounded-full border border-vp-safety/40 bg-white/90 text-vp-safety text-[10px] font-medium px-2 py-0.5">
          Safety Area
        </span>
        <span className="inline-flex items-center rounded-full border border-gray-300 bg-white/90 text-gray-500 text-[10px] font-medium px-2 py-0.5">
          Bleed
        </span>
        {modifierLabel && (
          <span className="inline-flex items-center rounded-full border border-vp-accent/30 bg-white/90 text-vp-accent text-[10px] font-semibold px-2 py-0.5 tabular-nums">
            {modifierLabel}
          </span>
        )}
      </div>

      {/* HORIZONTAL RULER — sits BELOW the bleed, spans its full width,
          with T-shaped end caps and the length value centred on top. */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: cx - bleedWPx / 2,
          top: cy + bleedHPx / 2 + RULER_OFFSET,
          width: bleedWPx,
          height: 1,
        }}
      >
        {/* Main ruler line */}
        <div className="absolute inset-0 bg-slate-300" />
        {/* Left end cap */}
        <div
          className="absolute bg-slate-300"
          style={{ left: 0, top: -TICK, width: 1, height: TICK * 2 + 1 }}
        />
        {/* Right end cap */}
        <div
          className="absolute bg-slate-300"
          style={{ right: 0, top: -TICK, width: 1, height: TICK * 2 + 1 }}
        />
        {/* Centred label — small white pill so it breaks the line cleanly */}
        <div
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 px-1.5 bg-vp-rail text-[10.5px] text-slate-500 font-medium whitespace-nowrap"
          style={{ top: 0 }}
        >
          {lengthLabel}
        </div>
      </div>

      {/* VERTICAL RULER — sits LEFT of the bleed, spans its full height,
          with end caps and the width value rotated alongside. */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: cx - bleedWPx / 2 - RULER_OFFSET,
          top: cy - bleedHPx / 2,
          width: 1,
          height: bleedHPx,
        }}
      >
        <div className="absolute inset-0 bg-slate-300" />
        {/* Top end cap */}
        <div
          className="absolute bg-slate-300"
          style={{ top: 0, left: -TICK, width: TICK * 2 + 1, height: 1 }}
        />
        {/* Bottom end cap */}
        <div
          className="absolute bg-slate-300"
          style={{ bottom: 0, left: -TICK, width: TICK * 2 + 1, height: 1 }}
        />
        {/* Rotated label */}
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-1.5 py-0 bg-vp-rail text-[10.5px] text-slate-500 font-medium whitespace-nowrap"
          style={{ transform: "translate(-50%, -50%) rotate(-90deg)" }}
        >
          {widthLabel}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* designOps — load saved fabric JSON / clear all user content        */
/*                                                                     */
/* Used by the Recent Designs picker and the Settings gear's          */
/* "Clear canvas" action. Implementation lives inside Workspace's     */
/* effect (so it has the canvas + drawGuides + clipPath helpers in    */
/* scope); we just expose a stable module-level facade.               */
/* ------------------------------------------------------------------ */

interface DesignOpsImpl {
  loadJson: (json: any, lengthMm: number, widthMm: number) => Promise<void>;
  /** Force a fresh drawGuides call using the CURRENT store state. Used
   *  by side-switch / load flows that need guides to redraw regardless
   *  of React effect batching. */
  redrawGuides: () => void;
  clearAll: () => void;
}

let _designOps: DesignOpsImpl | null = null;

export function _registerDesignOps(impl: DesignOpsImpl | null) {
  _designOps = impl;
}

export const designOps = {
  loadJson: (json: any, lengthMm: number, widthMm: number) =>
    _designOps?.loadJson(json, lengthMm, widthMm),
  clearAll: () => _designOps?.clearAll(),
  redrawGuides: () => _designOps?.redrawGuides(),
};
