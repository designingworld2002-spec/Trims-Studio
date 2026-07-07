import { useEffect, useRef, useState, useCallback } from "react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import type { CanvasShape, ShapeModifiers } from "@/store/canvasStore";
import { HistoryManager } from "@/lib/history";
import { _registerHistory, history } from "@/lib/historyAccessor";
import { Autosave, loadSavedDesign, syncWorkIdToUrl } from "@/lib/autosave";
import { useSmartGuides } from "@/lib/useSmartGuides";
import { analyzeImageElementSharpness } from "@/lib/imageQuality";
import { TopContextualToolbar } from "./TopContextualToolbar";
import { ObjectActionMenu } from "./ObjectActionMenu";
import { RevertToTemplate } from "./RevertToTemplate";
import { SideToggle } from "./SideToggle";
import { WarningToast } from "./WarningToast";
import { StudioTour } from "./StudioTour";

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
 * apex on the SHORT-AXIS edge that the tag hangs from. `pointHeight`
 * is the depth of the triangular point in px.
 *   - vertical (w ≤ h)   → apex on TOP, square bottom
 *   - horizontal (w > h) → apex on RIGHT, square left (the canonical
 *                          "top" is rotated 90° clockwise to the right)
 */
function pointedTopPoints(
  left: number,
  top: number,
  w: number,
  h: number,
  pointHeight: number
): { x: number; y: number }[] {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const p = Math.max(0, Math.min(pointHeight, h * 0.5, w * 0.45));
    return [
      { x: left + w, y: top + h / 2 }, // apex on RIGHT
      { x: left + w - p, y: top + h }, // bottom-right after the slope
      { x: left, y: top + h }, // bottom-left
      { x: left, y: top }, // top-left
      { x: left + w - p, y: top }, // top-right after the slope
    ];
  }
  const p = Math.max(0, Math.min(pointHeight, w * 0.5, h * 0.45));
  return [
    { x: left + w / 2, y: top }, // apex on TOP
    { x: left + w, y: top + p }, // top-right after the slope
    { x: left + w, y: top + h }, // bottom-right
    { x: left, y: top + h }, // bottom-left
    { x: left, y: top + p }, // top-left after the slope
  ];
}

/**
 * Points for a HEXAGON-POINTED tag — single apex on both short-axis
 * edges, straight long-axis sides. `pointHeight` controls the depth of
 * BOTH apex triangles.
 *   - vertical (w ≤ h)   → apexes on TOP + BOTTOM, vertical long sides
 *   - horizontal (w > h) → apexes on LEFT + RIGHT, horizontal long sides
 */
function hexagonPointedPoints(
  left: number,
  top: number,
  w: number,
  h: number,
  pointHeight: number
): { x: number; y: number }[] {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const p = Math.max(0, Math.min(pointHeight, h * 0.5, w * 0.4));
    return [
      { x: left + w, y: top + h / 2 }, // right apex
      { x: left + w - p, y: top + h },
      { x: left + p, y: top + h },
      { x: left, y: top + h / 2 }, // left apex
      { x: left + p, y: top },
      { x: left + w - p, y: top },
    ];
  }
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
 * SVG path data for a FLARED tag — the two LONG edges curve inward
 * (concave waist), the two SHORT edges stay straight. `waist` is the
 * maximum inset at the midpoint of each long side.
 *   - vertical (w ≤ h)   → vertical sides curve in, top + bottom straight
 *   - horizontal (w > h) → top + bottom curve in, left + right straight
 */
function flaredPath(w: number, h: number, waist: number): string {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const d = Math.max(0, Math.min(waist, h * 0.35));
    return [
      `M 0 0`,
      // Top edge curves inward — control point pulled DOWN toward centre.
      `Q ${w / 2} ${d} ${w} 0`,
      `L ${w} ${h}`,
      // Bottom edge mirrors — control point pulled UP toward centre.
      `Q ${w / 2} ${h - d} 0 ${h}`,
      "Z",
    ].join(" ");
  }
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
 * SVG path data for a MIXED-CUT-ROUND tag — angled cut on the two
 * corners adjacent to the hang edge + rounded arc on the opposite two
 * corners. Single `corner` value drives both for a balanced silhouette.
 *   - vertical (w ≤ h)   → cut TL + TR, round BL + BR
 *   - horizontal (w > h) → cut TR + BR (right hang edge), round TL + BL
 */
function mixedCutRoundPath(w: number, h: number, corner: number): string {
  const isHorizontal = w > h;
  const c = Math.max(0, Math.min(corner, w * 0.4, h * 0.4));
  if (isHorizontal) {
    return [
      `M 0 ${c}`,
      `A ${c} ${c} 0 0 1 ${c} 0`, // rounded TL
      `L ${w - c} 0`,
      `L ${w} ${c}`, // angled cut TR
      `L ${w} ${h - c}`,
      `L ${w - c} ${h}`, // angled cut BR
      `L ${c} ${h}`,
      `A ${c} ${c} 0 0 1 0 ${h - c}`, // rounded BL
      "Z",
    ].join(" ");
  }
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

/**
 * SVG path data for a BOUTIQUE tag — ornate profile with concave
 * shoulders flanking a central convex bump on the hang edge. The other
 * three edges stay straight. `depth` is the height of the central bump
 * above the shoulder line.
 *   - vertical (w ≤ h)   → ornate profile on TOP
 *   - horizontal (w > h) → ornate profile on RIGHT (rotated 90° CW)
 */
function boutiquePath(w: number, h: number, depth: number): string {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const d = Math.max(0, Math.min(depth, w * 0.45));
    // Profile on the RIGHT edge: shoulders at (w-d, 0) and (w-d, h),
    // apex at (w, h/2). Two cubic Beziers mirror across the midline.
    return [
      `M 0 0`,
      `L ${w - d} 0`,
      `C ${w - d} ${h * 0.15}, ${w} ${h * 0.3}, ${w} ${h / 2}`,
      `C ${w} ${h * 0.7}, ${w - d} ${h * 0.85}, ${w - d} ${h}`,
      `L 0 ${h}`,
      "Z",
    ].join(" ");
  }
  const d = Math.max(0, Math.min(depth, h * 0.45));
  return [
    `M 0 ${d}`,
    `C ${w * 0.15} ${d}, ${w * 0.3} 0, ${w / 2} 0`,
    `C ${w * 0.7} 0, ${w * 0.85} ${d}, ${w} ${d}`,
    `L ${w} ${h}`,
    `L 0 ${h}`,
    "Z",
  ].join(" ");
}

/**
 * SVG path data for an ARCH (tombstone) tag — three square edges + one
 * semi-circular hang edge. Half-arc when the tag is too short to hold
 * a full semicircle so the silhouette never escapes the bleed.
 *   - vertical (w ≤ h)   → arc on TOP edge, radius = w/2
 *   - horizontal (w > h) → arc on RIGHT edge, radius = h/2
 */
function archPath(w: number, h: number): string {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const r = h / 2;
    const arcW = Math.min(r, w * 0.5);
    return [
      `M 0 0`,
      `L ${w - arcW} 0`,
      `A ${arcW} ${r} 0 0 1 ${w - arcW} ${h}`,
      `L 0 ${h}`,
      "Z",
    ].join(" ");
  }
  const r = w / 2;
  const arcH = Math.min(r, h * 0.5);
  return [
    `M 0 ${arcH}`,
    `A ${r} ${arcH} 0 0 1 ${w} ${arcH}`,
    `L ${w} ${h}`,
    `L 0 ${h}`,
    "Z",
  ].join(" ");
}

/**
 * SVG path data for a BARREL (bent oval) tag — convex bulges on the
 * two SHORT edges, straight long edges. Uses CUBIC Béziers with
 * control points pulled out by `d/3` along the bulge axis so the curve
 * leaves the corners with a TANGENT MATCHING the straight side (no
 * visible kink) and peaks exactly on the bleed edge at midpoint.
 *
 * Math: cubic B(0.5) = (P0 + 3P1 + 3P2 + P3) / 8. With control coords
 * `-d/3`, the bulge axis component is (d - d - d + d) / 8 = 0 — peak
 * touches the bounding rect. Tangent at P0 is (P1 - P0) = (0, -4d/3),
 * collinear with the straight side direction → smooth join.
 *
 *   - vertical (w ≤ h)   → bulges on TOP + BOTTOM
 *   - horizontal (w > h) → bulges on LEFT + RIGHT
 */
function barrelPath(w: number, h: number, bulge: number): string {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const d = Math.max(0, Math.min(bulge, w * 0.45));
    const k = d / 3;
    return [
      `M ${d} 0`,
      `L ${w - d} 0`,
      // Right bulge — peak at (w, h/2).
      `C ${w + k} 0, ${w + k} ${h}, ${w - d} ${h}`,
      `L ${d} ${h}`,
      // Left bulge — peak at (0, h/2).
      `C ${-k} ${h}, ${-k} 0, ${d} 0`,
      "Z",
    ].join(" ");
  }
  const d = Math.max(0, Math.min(bulge, h * 0.45));
  const k = d / 3;
  return [
    `M 0 ${d}`,
    // Top bulge — peak at (w/2, 0).
    `C 0 ${-k}, ${w} ${-k}, ${w} ${d}`,
    `L ${w} ${h - d}`,
    // Bottom bulge — peak at (w/2, h).
    `C ${w} ${h + k}, 0 ${h + k}, 0 ${h - d}`,
    "Z",
  ].join(" ");
}

/**
 * SVG path data for a PILL (capsule) tag — the SHORT pair of edges is
 * replaced by perfect 180° semi-circles. Tall tags get top + bottom
 * caps; wide tags get left + right caps.
 */
function pillPath(w: number, h: number): string {
  if (h >= w) {
    const r = w / 2;
    return [
      `M 0 ${r}`,
      `A ${r} ${r} 0 0 1 ${w} ${r}`, // top semi-circle
      `L ${w} ${h - r}`,
      `A ${r} ${r} 0 0 1 0 ${h - r}`, // bottom semi-circle
      "Z",
    ].join(" ");
  }
  const r = h / 2;
  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `A ${r} ${r} 0 0 1 ${w - r} ${h}`, // right semi-circle
    `L ${r} ${h}`,
    `A ${r} ${r} 0 0 1 ${r} 0`, // left semi-circle
    "Z",
  ].join(" ");
}

/**
 * SVG path data for a TICKET tag — a small concave quadratic-Bezier
 * notch is bitten out of EACH of the 4 vertices. `notch` is the
 * straight-edge distance from each corner before the notch begins.
 */
function ticketPath(w: number, h: number, notch: number): string {
  const r = Math.max(0, Math.min(notch, w * 0.4, h * 0.4));
  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `Q ${w - r} ${r} ${w} ${r}`, // TR concave notch
    `L ${w} ${h - r}`,
    `Q ${w - r} ${h - r} ${w - r} ${h}`, // BR concave notch
    `L ${r} ${h}`,
    `Q ${r} ${h - r} 0 ${h - r}`, // BL concave notch
    `L 0 ${r}`,
    `Q ${r} ${r} ${r} 0`, // TL concave notch
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
    case "boutique":
      return new fabric.Path(boutiquePath(w, h, opts.slantPx), {
        left,
        top,
        ...style,
      });
    case "arch":
      return new fabric.Path(archPath(w, h), {
        left,
        top,
        ...style,
      });
    case "barrel":
      return new fabric.Path(barrelPath(w, h, opts.slantPx), {
        left,
        top,
        ...style,
      });
    case "pill":
      return new fabric.Path(pillPath(w, h), {
        left,
        top,
        ...style,
      });
    case "ticket":
      return new fabric.Path(ticketPath(w, h, opts.cornerRadiusPx), {
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

  // Wipe existing guides (HMR, undo restores, dim changes). MUST include
  // the destination-out CUTOUT (`holePunch-cutout`) — otherwise every
  // redraw (dimension change, orientation flip, undo, side switch, HMR)
  // leaves the OLD cutout behind and stacks a new one. A leftover cutout
  // from a previous position keeps erasing pixels at a stale spot,
  // surfacing as a stray "punch hole / dot" near the top of the tag.
  const holeCutoutId = `${GUIDE_IDS.holePunch}-cutout`;
  const stale = canvas.getObjects().filter((o) => {
    const id = (o as any).id;
    return (
      id === GUIDE_IDS.bleed ||
      id === GUIDE_IDS.safety ||
      id === GUIDE_IDS.holePunch ||
      id === holeCutoutId
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
  //    Two-layer rendering keeps the hole physically real on-canvas:
  //
  //      • CUTOUT (destination-out): solid disc that ERASES every pixel
  //        below it — canvas background, template fill, even user text
  //        the user dragged over the hole. The workspace surface shows
  //        through, matching what the final die-cut tag will look like.
  //      • RING (source-over): transparent fill, red dashed stroke —
  //        the visible "don't place here" guide rendered ON TOP of the
  //        cutout so the user can still see the boundary.
  //
  //    Both excluded from export — the saved PNG already alpha-punches
  //    its own hole via the export-side helper.
  const { visualGuides } = useCanvasStore.getState().productConfig;
  if (visualGuides.hasHolePunch && visualGuides.holePunchRadiusMm > 0) {
    const holeR = visualGuides.holePunchRadiusMm * MM_TO_PX;
    const holeOffsetPx = visualGuides.holePunchOffsetFromTopMm * MM_TO_PX;
    const holeCenterX =
      tagOrientation === "horizontal"
        ? bleedLeft + bleedW - holeOffsetPx
        : cx;
    const holeCenterY =
      tagOrientation === "horizontal" ? cy : bleedTop + holeOffsetPx;
    const cutout = new fabric.Circle({
      radius: holeR,
      left: holeCenterX,
      top: holeCenterY,
      originX: "center",
      originY: "center",
      fill: "#000000",
      stroke: undefined,
      strokeWidth: 0,
      globalCompositeOperation: "destination-out",
      ...baseProps,
    } as any);
    (cutout as any).id = `${GUIDE_IDS.holePunch}-cutout`;
    Object.assign(cutout, baseAny);
    canvas.add(cutout);
    canvas.bringToFront(cutout);

    const ring = new fabric.Circle({
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
    (ring as any).id = GUIDE_IDS.holePunch;
    Object.assign(ring, baseAny);
    canvas.add(ring);
    canvas.bringToFront(ring);
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
    case "boutique":
      return new fabric.Path(
        boutiquePath(g.safetyW, g.safetyH, g.safetySlantPx),
        { left: g.safetyLeft, top: g.safetyTop, ...opts }
      );
    case "arch":
      return new fabric.Path(archPath(g.safetyW, g.safetyH), {
        left: g.safetyLeft,
        top: g.safetyTop,
        ...opts,
      });
    case "barrel":
      return new fabric.Path(
        barrelPath(g.safetyW, g.safetyH, g.safetySlantPx),
        { left: g.safetyLeft, top: g.safetyTop, ...opts }
      );
    case "pill":
      return new fabric.Path(pillPath(g.safetyW, g.safetyH), {
        left: g.safetyLeft,
        top: g.safetyTop,
        ...opts,
      });
    case "ticket":
      return new fabric.Path(
        ticketPath(g.safetyW, g.safetyH, g.safetyCornerRadiusPx),
        { left: g.safetyLeft, top: g.safetyTop, ...opts }
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
  const activeSide = useCanvasStore((s) => s.activeSide);
  const supportsBackSide = useCanvasStore(
    (s) => s.productConfig.supportsBackSide
  );
  const loadActiveSideJson = useCanvasStore((s) => s.loadActiveSideJson);
  const flipWrapperRef = useRef<HTMLDivElement | null>(null);
  const prevActiveSideRef = useRef(activeSide);

  // Interactive onboarding tour — auto-opens once for first-time users,
  // and is re-openable any time via the Help button (which flips the
  // same store flag). The localStorage flag is set + the tour opened in
  // the SAME tick, so StrictMode's double-mount is safe: the first mount
  // marks "seen" and activates; the second mount sees the flag and skips
  // (the active state from the first mount persists in the store).
  const isTourActive = useCanvasStore((s) => s.isTourActive);
  const setTourActive = useCanvasStore((s) => s.setTourActive);
  useEffect(() => {
    try {
      if (!localStorage.getItem("hasSeenStudioIntro")) {
        localStorage.setItem("hasSeenStudioIntro", "1");
        // StudioTour polls + measures targets itself, so opening now is
        // safe even before the rails finish their first paint.
        setTourActive(true);
      }
    } catch {
      /* localStorage blocked (private mode) — just skip the auto-tour. */
    }
  }, [setTourActive]);

  // Half-flip: animate the wrapper 0→90deg (canvas goes edge-on), swap
  // content, JUMP to -90deg with no transition, then animate -90→0deg.
  // Net result: the fabric canvas always settles at rotation 0, so it
  // stays editable and mouse coordinates remain accurate.
  useEffect(() => {
    if (!supportsBackSide) return;
    if (activeSide === prevActiveSideRef.current) return;
    prevActiveSideRef.current = activeSide;
    const el = flipWrapperRef.current;
    if (!el) {
      // Canvas wrapper hasn't mounted yet — fall back to a plain load.
      loadActiveSideJson();
      return;
    }
    // Flip axis: ONLY hang tags flip vertically (rotateX) when in
    // landscape orientation. Every other product (cotton / satin /
    // taffeta / washcare / size labels) always flips horizontally
    // (rotateY, book-like) regardless of aspect ratio.
    const isLandscape = lengthMm > widthMm;
    const shouldFlipVertically =
      productConfig.handle === "hang-tags" && isLandscape;
    const axis: "X" | "Y" = shouldFlipVertically ? "X" : "Y";

    // Phase 1 — animate to edge-on (invisible).
    el.style.transition = "transform 250ms ease-in-out";
    el.style.transform = `rotate${axis}(90deg)`;

    const t1 = window.setTimeout(() => {
      // At the edge-on midpoint:
      //   1. Swap content into the now-invisible canvas.
      //   2. Jump to the OPPOSITE invisible edge with transition disabled.
      //   3. Force a reflow so the browser flushes the no-transition jump.
      //   4. Re-enable the transition and animate to 0deg.
      loadActiveSideJson();
      el.style.transition = "none";
      el.style.transform = `rotate${axis}(-90deg)`;
      // Reflow — reading offsetHeight forces layout to commit the jump
      // before we restore the transition (otherwise the browser batches
      // both writes and tweens the -90 → 0 transition starting from 90).
      void el.offsetHeight;
      el.style.transition = "transform 250ms ease-in-out";
      el.style.transform = `rotate${axis}(0deg)`;
    }, 260);

    // Final safety reset. After both 250ms animations complete (520ms
    // total) we explicitly force the wrapper to `rotateY(0deg)` — even
    // if a stray transition is mid-flight or React re-renders during
    // the swap, the canvas can NEVER come to rest at 180°. This
    // guarantees fabric mouse coordinates + text are never mirrored.
    const t2 = window.setTimeout(() => {
      el.style.transition = "none";
      el.style.transform = "rotateY(0deg)";
      void el.offsetHeight;
      el.style.transition = "transform 250ms ease-in-out";
    }, 540);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [
    activeSide,
    supportsBackSide,
    lengthMm,
    widthMm,
    productConfig.handle,
    loadActiveSideJson,
  ]);

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

  // True while the user is actively dragging or scaling an object — used
  // to HIDE the centred low-quality warning badge during interaction so
  // it doesn't obstruct the image being positioned.
  const [isObjectMoving, setIsObjectMoving] = useState(false);

  // Centre point (CSS px relative to the stage) of the active object,
  // used to render the pulsing low-quality warning badge directly over a
  // flagged image. `flagged` mirrors isLowRes || isBlurry on the active
  // image; `visible` also requires the object to be an image.
  const [warnBadge, setWarnBadge] = useState<{
    left: number;
    top: number;
    visible: boolean;
  }>({ left: 0, top: 0, visible: false });

  // True briefly while the user is zooming (mouse wheel OR the +/-/reset
  // buttons) — used to HIDE the centred warning badge during the zoom so
  // it doesn't visually lag the rescaling image. Debounced: clears 200ms
  // after the last zoom tick, then the badge position is recomputed.
  const [isZooming, setIsZooming] = useState(false);
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        updateWarnBadge(canvas);
      }, 0);
    };
    const clear = () => {
      window.setTimeout(() => {
        updateActiveObject(null);
        setActionMenuPos((p) => ({ ...p, visible: false }));
        setWarnBadge((p) => ({ ...p, visible: false }));
      }, 0);
    };

    // selection:created/updated — re-flag low-res images so the toolbar
    // banner is immediate, AND auto-open the Text tab when a text object
    // is selected so the user can edit it without double-clicking.
    const TEXT_TYPES = ["textbox", "i-text", "text"];
    const syncWithLowRes = (e?: any) => {
      const tgt = e?.target ?? e?.selected?.[0];
      if (tgt && tgt.type === "image") updateLowResFlag(tgt as fabric.Image);
      if (tgt && TEXT_TYPES.includes(tgt.type)) {
        // Don't fight Preview mode (panels are hidden there).
        if (!useCanvasStore.getState().previewMode) {
          useCanvasStore.getState().openTool("text");
        }
      }
      sync();
    };
    canvas.on("selection:created", syncWithLowRes);
    canvas.on("selection:updated", syncWithLowRes);
    canvas.on("selection:cleared", clear);
    canvas.on("object:modified", (e) => {
      // Drag/scale gesture finished → reveal the centred warning badge.
      setIsObjectMoving(false);
      // Re-flag image quality (applies/clears the red dashed border +
      // isLowRes/isBlurry flags). No toast — the on-canvas border +
      // centred badge + toolbar banner are the only indicators now.
      if (e?.target?.type === "image") {
        updateLowResFlag(e.target as fabric.Image);
      }
      sync();
    });
    canvas.on("object:scaling", (e) => {
      // Scaling in progress → hide the badge so it doesn't obstruct.
      setIsObjectMoving(true);
      updateActionMenuPos(canvas);
      // Live-DPI tick: as the user drags a scale handle we re-flag the
      // image every event so the red border updates the INSTANT they
      // cross the safe-resolution threshold.
      if (e?.target?.type === "image") {
        updateLowResFlag(e.target as fabric.Image);
      }
    });
    canvas.on("object:rotating", () => updateActionMenuPos(canvas));

    // Drag handler — no hard clamp anymore. Each user object carries an
    // absolute-positioned `clipPath` matching the safety rectangle, so any
    // portion of the object that escapes the safe area is visually hidden
    // (per spec: "soft clip", not "hard block"). We just keep the floating
    // ObjectActionMenu in sync with the new position.
    canvas.on("object:moving", (opt) => {
      // Drag in progress → hide the badge until the user drops.
      setIsObjectMoving(true);
      updateActionMenuPos(canvas);
      runCollisionCheck(canvas, opt.target);
    });
    canvas.on("object:scaling", (opt) => {
      runCollisionCheck(canvas, opt.target);
    });
    // mouse:up is the definitive "gesture ended" signal — covers cases
    // where object:modified doesn't fire (e.g. a click without a move).
    canvas.on("mouse:up", () => {
      setIsObjectMoving(false);
      updateWarnBadge(canvas);
    });

    // Mouse-wheel zoom — exactly 10% per tick. This app zooms via a
    // center-anchored CSS transform on the stage wrapper (fabric's own
    // viewportTransform stays identity), so we DON'T use
    // canvas.zoomToPoint — we just bump the store `zoom`, which the
    // stage scale reads. Clamped to 10%–400%.
    canvas.on("mouse:wheel", (opt) => {
      const e = opt.e as WheelEvent;
      e.preventDefault();
      e.stopPropagation();
      const store = useCanvasStore.getState();
      const curPct = Math.round(store.zoom * 100);
      const delta = e.deltaY;
      const steppedPct = delta < 0 ? curPct + 10 : curPct - 10;
      const clampedPct = Math.max(10, Math.min(400, steppedPct));
      if (clampedPct !== curPct) {
        store.setZoom(clampedPct / 100);
      }
      // Hide the badge immediately for this tick; the [zoom] effect also
      // fires, but calling here makes the hide instantaneous.
      triggerZoomActivity();
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
      // Quality detection for EVERY freshly-added image — uploads AND
      // library-URL adds both flow through object:added, so this single
      // hook covers both. Runs DPI + optical-blur and applies the red
      // dashed border via updateLowResFlag. We defer one frame so the
      // fabric element is fully decoded before we sample it.
      if (target.type === "image") {
        const runFlag = () => {
          // Flags + red dashed border only — no global toast.
          updateLowResFlag(target as fabric.Image);
          canvas.requestRenderAll();
        };
        const el = (target as fabric.Image).getElement?.() as
          | HTMLImageElement
          | undefined;
        if (el && !el.complete) {
          el.addEventListener("load", runFlag, { once: true });
        } else {
          // Already decoded — still defer a frame so getElement() is set.
          requestAnimationFrame(runFlag);
        }
      }
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
      loadJson: (json, lengthMm, widthMm, opts) =>
        new Promise<void>((resolve) => {
          const skipFit = opts?.skipFit === true;
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

            // Side-switch loads (`skipFit`) are already sized for the
            // current bleed — fitting them would inflate the composition
            // on every Front↔Back switch. Only template / recent-design
            // loads fit-to-bleed.
            if (!skipFit && userObjects.length > 0) {
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

          // ── Seed a pre-authored BACK design, if the template ships one ──
          // Two-sided Trims templates may carry a top-level `back` fabric
          // payload alongside the (front) `fabric`. Seeding it into the store
          // makes the Front/Back toggle load it directly — skipping the
          // "start the back" chooser — so the back shows up pre-filled.
          //
          // Back payloads are authored in FINAL canvas coordinates (centred
          // in the 2000² stage) and loaded with `skipFit`, so — unlike the
          // cover-fit front — they must already sit inside the bleed.
          try {
            const rawBack = (raw as any)?.back;
            const backPayload = rawBack
              ? sanitizeFabricPayload(extractFabricPayload(rawBack))
              : null;
            if (backPayload && Array.isArray(backPayload.objects)) {
              const st = useCanvasStore.getState();
              st.setBackDesign({
                fabric: backPayload,
                backgroundColor:
                  (typeof backPayload.background === "string" &&
                    backPayload.background) ||
                  st.backgroundColor,
                tagOrientation: st.tagOrientation,
                lengthMm,
                widthMm,
              });
            }
          } catch (err) {
            console.warn("[trims-studio] Back template seed failed:", err);
          }

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

  /* ----- Position the centred low-quality warning badge ----- */
  const updateWarnBadge = useCallback((canvasArg?: fabric.Canvas) => {
    // Allow calling with no arg (e.g. from triggerZoomActivity) — fall
    // back to the live canvas from the store.
    const canvas = canvasArg ?? useCanvasStore.getState().canvas;
    if (!canvas) {
      setWarnBadge((p) => (p.visible ? { ...p, visible: false } : p));
      return;
    }
    const active = canvas.getActiveObject() as any;
    const stage = stageRef.current;
    if (
      !active ||
      !stage ||
      active.type !== "image" ||
      !(active.isLowRes || active.isBlurry)
    ) {
      setWarnBadge((p) => (p.visible ? { ...p, visible: false } : p));
      return;
    }
    // Centre of the object's bounding rect, converted to CSS px (the
    // stage element shares the canvas top-left, same as the action menu).
    const br = active.getBoundingRect(true, true);
    const scale = fitScaleRef.current * zoomRef.current;
    setWarnBadge({
      left: (br.left + br.width / 2) * scale,
      top: (br.top + br.height / 2) * scale,
      visible: true,
    });
  }, []);

  // Use refs for fitScale + zoom so updateActionMenuPos always sees latest.
  const fitScaleRef = useRef(1);
  const zoomRef = useRef(1);
  fitScaleRef.current = fitScale;
  zoomRef.current = zoom;

  // Recompute action menu + warning badge positions when scale changes.
  useEffect(() => {
    const canvas = useCanvasStore.getState().canvas;
    if (canvas && canvas.getActiveObject()) {
      updateActionMenuPos(canvas);
      updateWarnBadge(canvas);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitScale, zoom]);

  // Debounced "is the user actively zooming?" signal. Hides the centred
  // warning badge during the zoom and recomputes its position 200ms
  // after the last zoom tick. Marked stable via useCallback so the
  // mouse:wheel handler (registered once on mount) can call it.
  const triggerZoomActivity = useCallback(() => {
    setIsZooming(true);
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = setTimeout(() => {
      setIsZooming(false);
      updateWarnBadge();
    }, 200);
  }, [updateWarnBadge]);

  // Any zoom change — mouse wheel, the +/- buttons, or reset — funnels
  // through the store `zoom`, so a single effect covers EVERY source.
  // Skip the very first run (mount) so we don't flash the badge hidden
  // before the user has done anything.
  const zoomMountRef = useRef(true);
  useEffect(() => {
    if (zoomMountRef.current) {
      zoomMountRef.current = false;
      return;
    }
    triggerZoomActivity();
  }, [zoom, triggerZoomActivity]);

  // Tidy the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    };
  }, []);

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
        data-tour="canvas"
        className="relative shrink-0"
        style={{
          width: stagePxSize,
          height: stagePxSize,
        }}
      >
        {/* Canvas — virtual resolution, scaled from CENTER. Outer layer
            handles zoom/translate so the inner half-flip orchestration
            animates cleanly on top of a static scale baseline. The
            inner wrapper always RESTS at rotate(0deg) — see the
            useHalfFlip hook for the 0→90→-90→0 sequence that gives a
            real flip illusion without ever leaving the fabric canvas
            mirrored (which would invert mouse coords + text). */}
        <div
          className="absolute"
          style={{
            width: VIRTUAL_SIZE,
            height: VIRTUAL_SIZE,
            top: "50%",
            left: "50%",
            transform: `translate(-50%, -50%) scale(${totalScale})`,
            transformOrigin: "center center",
            perspective: "2400px",
          }}
        >
          <div
            ref={flipWrapperRef}
            className="vp-canvas-shadow"
            style={{
              width: "100%",
              height: "100%",
              position: "relative",
              transformStyle: "preserve-3d",
              transition: "transform 250ms ease-in-out",
              transform: "rotateY(0deg)",
            }}
          >
            <canvas ref={canvasElRef} />
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

        {/* Centred low-quality warning badge — rendered directly over the
            centre of a flagged image. Hidden while the user is dragging
            or scaling so it never obstructs positioning, and reappears
            on drop. */}
        {!previewMode && warnBadge.visible && !isObjectMoving && !isZooming && (
          <div
            aria-label="Low-quality image warning"
            title="This image may print blurry"
            className="absolute z-20 pointer-events-none flex items-center justify-center w-6 h-6 rounded-full bg-red-600 text-white shadow-md ring-2 ring-white animate-pulse"
            style={{
              left: warnBadge.left,
              top: warnBadge.top,
              transform: "translate(-50%, -50%)",
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
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

      {/* Top-right warning toast — safe area / hole punch / low-res. */}
      <WarningToast />

      {/* Interactive onboarding tour overlay (live element highlighting). */}
      {isTourActive && <StudioTour />}

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
    case "boutique":
      clipPath = `path('${boutiquePath(bleedW, bleedH, slantPx)}')`;
      break;
    case "arch":
      clipPath = `path('${archPath(bleedW, bleedH)}')`;
      break;
    case "barrel":
      clipPath = `path('${barrelPath(bleedW, bleedH, slantPx)}')`;
      break;
    case "pill":
      clipPath = `path('${pillPath(bleedW, bleedH)}')`;
      break;
    case "ticket":
      clipPath = `path('${ticketPath(bleedW, bleedH, radiusPx)}')`;
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
  } else if (shape === "boutique") {
    const v = Math.min(modifiers.slantLengthMm, maxModifierMm);
    modifierLabel = `Curve: ${v} mm`;
  } else if (shape === "barrel") {
    const v = Math.min(modifiers.slantLengthMm, maxModifierMm);
    modifierLabel = `Bulge: ${v} mm`;
  } else if (shape === "ticket") {
    const v = Math.min(modifiers.cornerRadiusMm, maxModifierMm);
    modifierLabel = `Notch: ${v} mm`;
  }
  // arch + pill take no modifier — geometry follows the bleed dims.

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
  loadJson: (
    json: any,
    lengthMm: number,
    widthMm: number,
    opts?: { skipFit?: boolean }
  ) => Promise<void>;
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
  /**
   * Load fabric JSON onto the live canvas.
   *
   * `opts.skipFit` — skip the fit-to-bleed rescale. Templates / Recent
   * Designs are authored at arbitrary sizes, so they SHOULD be scaled to
   * fill the new bleed (default). But a Front↔Back side snapshot is
   * already sized for the current canvas — fitting it would inflate the
   * content on every switch, so the side-switch path passes `skipFit`.
   */
  loadJson: (
    json: any,
    lengthMm: number,
    widthMm: number,
    opts?: { skipFit?: boolean }
  ) => _designOps?.loadJson(json, lengthMm, widthMm, opts),
  clearAll: () => _designOps?.clearAll(),
  redrawGuides: () => _designOps?.redrawGuides(),
};

/**
 * Live collision check fired on every drag tick + scale tick. If the
 * active object intersects the hole-punch or escapes the safety
 * rectangle, raise the top-right warning toast; if the user has just
 * moved BACK into the safe area, clear it. Guards against the toast
 * thrashing by no-oping when the message is unchanged.
 */
function runCollisionCheck(
  canvas: fabric.Canvas,
  target: fabric.Object | undefined
): void {
  if (!target || (target as any).excludeFromExport) return;
  const objs = canvas.getObjects();
  const safety = objs.find((o) => (o as any).id === "safety");
  const hole = objs.find((o) => (o as any).id === "holePunch");
  const targetBR = target.getBoundingRect(true, true);
  let warning: string | null = null;
  if (hole) {
    const hr = hole.getBoundingRect(true, true);
    const overlap =
      targetBR.left < hr.left + hr.width &&
      targetBR.left + targetBR.width > hr.left &&
      targetBR.top < hr.top + hr.height &&
      targetBR.top + targetBR.height > hr.top;
    if (overlap) {
      warning = "Warning: Design is over the punch hole!";
    }
  }
  if (!warning && safety) {
    const sr = safety.getBoundingRect(true, true);
    const outside =
      targetBR.left < sr.left ||
      targetBR.top < sr.top ||
      targetBR.left + targetBR.width > sr.left + sr.width ||
      targetBR.top + targetBR.height > sr.top + sr.height;
    if (outside) {
      warning = "Warning: Design is outside the safe area!";
    }
  }
  // Refresh image-quality flags + red dashed border as the user scales,
  // but DO NOT raise a toast for it — image quality is communicated only
  // via the on-canvas red border + the centred badge. (Raising it here
  // ran inside the object:moving / object:scaling loop and spammed the
  // toast on every tick.)
  if (target.type === "image") {
    updateLowResFlag(target as fabric.Image);
  }
  // Only collision warnings (punch-hole / safe-area) use the toast.
  const store = useCanvasStore.getState();
  const current = store.canvasWarning;
  if (warning) {
    if (current !== warning) store.setCanvasWarning(warning);
  } else if (current) {
    store.setCanvasWarning(null);
  }
}

/**
 * Compute effective print DPI for a fabric image and stamp the result
 * on the object so the contextual toolbar can show the red "Replace
 * Image" banner.
 *
 * Exact math (per spec):
 *   physicalWidthInches = (img.getScaledWidth() / MM_TO_PX) / 25.4
 *   effectiveDpi        = img.width / physicalWidthInches
 *
 * Where `MM_TO_PX = 10` (this project's virtual-canvas constant: 10
 * canvas units = 1 mm). The threshold is 150 DPI — below that we flag
 * the image as low-res and trigger the toast + sidebar banner.
 *
 * Returns `true` when the image is flagged low-res after this call.
 */
function updateLowResFlag(img: fabric.Image): boolean {
  const LOW_DPI_THRESHOLD = 150;
  // System-generated graphics (QR codes, barcodes) are crisp vector-
  // sourced rasters — they should never trip the "low quality / blurry"
  // warning. Skip them entirely and make sure no stale red border lingers.
  if ((img as any).qrUrl || (img as any).barcodeText) {
    (img as any).isLowRes = false;
    (img as any).isBlurry = false;
    if ((img as any).stroke === "#ef4444") {
      img.set({ stroke: undefined, strokeWidth: 0, strokeDashArray: undefined });
    }
    return false;
  }
  // Native pixel width — fabric copies this from the underlying <img>
  // at load time. Fall back to the DOM element's naturalWidth if it's
  // somehow missing (e.g. after a clone).
  const el = img.getElement?.() as HTMLImageElement | undefined;
  const naturalWidth =
    (img.width && img.width > 0 ? img.width : el?.naturalWidth) || 1;
  const scaledWidth =
    typeof img.getScaledWidth === "function"
      ? img.getScaledWidth()
      : (img.width || 1) * (img.scaleX || 1);
  const physicalWidthInches = scaledWidth / MM_TO_PX / 25.4;
  const effectiveDpi =
    physicalWidthInches > 0 ? naturalWidth / physicalWidthInches : Infinity;
  const lowRes =
    Number.isFinite(effectiveDpi) && effectiveDpi < LOW_DPI_THRESHOLD;
  (img as any).isLowRes = lowRes;
  (img as any).effectiveDpi = Math.round(effectiveDpi);

  // Optical-blur check over the ALREADY-LOADED element. This is what
  // catches library-URL images (no File object) AND genuinely soft
  // photos that have plenty of pixels but are out of focus. We cache
  // the verdict so we don't re-run the (cheap but non-trivial)
  // variance pass on every drag tick — only when the element changes.
  let blurry = (img as any).__blurChecked
    ? !!(img as any).isBlurry
    : false;
  if (!(img as any).__blurChecked && el) {
    const result = analyzeImageElementSharpness(el as HTMLImageElement);
    if (result) {
      blurry = result.isBlurry;
      (img as any).__blurChecked = true;
      console.log(
        "[updateLowResFlag] blur variance=%d blurry=%s",
        Math.round(result.variance),
        blurry
      );
    }
  }

  // `isBlurry` is the union flag the UI reads: low DPI (pixel stretch)
  // OR optical blur (out of focus). Either one means "this will print
  // soft" → red dashed border + toolbar warning + toast.
  const flagged = lowRes || blurry;
  (img as any).isBlurry = flagged;

  // On-canvas marker — a red dashed border drawn ON the image object so
  // the user sees exactly WHICH image is the problem. strokeUniform
  // keeps the dash crisp regardless of the image's scale. Cleared the
  // moment the image is no longer flagged (e.g. after sharpening or
  // scaling back down).
  if (flagged) {
    img.set({
      stroke: "#ef4444",
      strokeWidth: 2,
      strokeDashArray: [5, 5],
      strokeUniform: true,
    });
  } else if ((img as any).stroke === "#ef4444") {
    img.set({ stroke: undefined, strokeWidth: 0, strokeDashArray: undefined });
  }

  console.log(
    "[updateLowResFlag] effectiveDpi=%d lowRes=%s blurry=%s scaledWidth=%d natural=%d",
    Math.round(effectiveDpi),
    lowRes,
    blurry,
    Math.round(scaledWidth),
    naturalWidth
  );
  return flagged;
}
