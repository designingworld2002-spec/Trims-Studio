import { fabric } from "fabric";
import {
  getSupabase,
  isSupabaseConfigured,
  SUPABASE_DESIGNS_BUCKET,
  SHOPIFY_FINALIZE_URL,
} from "./supabase";
import type {
  CanvasShape,
  ShapeModifiers,
  SideSnapshot,
} from "@/store/canvasStore";
import { getProductConfig, type VisualGuides } from "@/config/productConfig";

/**
 * Final "Continue" save flow.
 *
 * 1. Render the trim area to a PNG dataURL.
 * 2. Upload the PNG to Supabase Storage (bucket from env).
 * 3. Insert a `user_designs` row with the public preview URL + raw fabric JSON.
 * 4. Redirect the storefront back to `/pages/finalize?design_id=…` so
 *    Shopify can render the preview alongside checkout details.
 *
 * Falls back to a localStorage save if Supabase isn't configured — useful
 * for local development before keys are wired up.
 */

export interface SaveDesignInput {
  canvas: fabric.Canvas;
  lengthMm: number;
  widthMm: number;
  productSlug: string | null;
  productTitle: string;
  customerId: string | null;
  workId: string | null;
  templateId: string | null;
  /** Active silhouette — included in the row + Shopify cart payload so
   *  the production team has the exact blueprint. */
  canvasShape: CanvasShape;
  shapeModifiers: ShapeModifiers;
  /** Tag orientation of the LIVE canvas at save time. Needed so Load
   *  can restore the correct hole-edge placement. */
  tagOrientation: "vertical" | "horizontal";
  /** Background fill of the LIVE canvas at save time. */
  backgroundColor: string;
  /** Which face is the LIVE canvas currently editing? Determines which
   *  side gets its snapshot from the live canvas vs. an offscreen render
   *  of the stored JSON. */
  activeSide: "front" | "back";
  /** Stored front-side snapshot (null if user only ever worked on back). */
  frontDesign: SideSnapshot | null;
  /** Stored back-side snapshot (null if product is single-sided or back
   *  was never touched). */
  backDesign: SideSnapshot | null;
  /** Does the active product support a back side? */
  supportsBackSide: boolean;
}

export interface SaveDesignResult {
  designId: string;
  previewUrl: string | null;
  previewUrlBack: string | null;
  finalizeUrl: string;
  storedRemotely: boolean;
}

interface SidePayload {
  /** PNG dataURL trimmed to the bleed rectangle. */
  previewDataUrl: string;
  /** Fabric JSON for this side's design. */
  fabricJson: any;
  /** mm dims at snapshot time. */
  lengthMm: number;
  widthMm: number;
  /** Tag orientation at snapshot time. */
  tagOrientation: "vertical" | "horizontal";
  /** Bleed background fill at snapshot time. */
  backgroundColor: string;
}

/**
 * The shape persisted under `meta.frontSide` / `meta.backSide` — every
 * field Load needs to reconstruct a faithful SideSnapshot.
 */
interface PersistedSideMeta {
  tagOrientation: "vertical" | "horizontal";
  backgroundColor: string;
  lengthMm: number;
  widthMm: number;
}

function metaFromPayload(p: SidePayload | null): PersistedSideMeta | null {
  if (!p) return null;
  return {
    tagOrientation: p.tagOrientation,
    backgroundColor: p.backgroundColor,
    lengthMm: p.lengthMm,
    widthMm: p.widthMm,
  };
}

const MM_TO_PX = 10;

/**
 * Build the destination-out cutout disc that physically punches a
 * transparent hole into an exported PNG. Mirrors the live-canvas hole
 * geometry in Workspace.tsx so the offscreen render of the inactive
 * side bakes an IDENTICAL native hole. Returns `null` when the product
 * has no hole punch.
 */
function buildHoleCutout(
  lengthMm: number,
  widthMm: number,
  tagOrientation: "vertical" | "horizontal",
  visualGuides: VisualGuides | undefined
): fabric.Circle | null {
  if (
    !visualGuides ||
    !visualGuides.hasHolePunch ||
    visualGuides.holePunchRadiusMm <= 0
  ) {
    return null;
  }
  const bleedW = lengthMm * MM_TO_PX;
  const bleedH = widthMm * MM_TO_PX;
  const cx = VIRTUAL_SIZE / 2;
  const cy = VIRTUAL_SIZE / 2;
  const bleedLeft = cx - bleedW / 2;
  const bleedTop = cy - bleedH / 2;
  const holeR = visualGuides.holePunchRadiusMm * MM_TO_PX;
  const holeOffsetPx = visualGuides.holePunchOffsetFromTopMm * MM_TO_PX;
  const holeCenterX =
    tagOrientation === "horizontal"
      ? bleedLeft + bleedW - holeOffsetPx
      : cx;
  const holeCenterY =
    tagOrientation === "horizontal" ? cy : bleedTop + holeOffsetPx;
  return new fabric.Circle({
    radius: holeR,
    left: holeCenterX,
    top: holeCenterY,
    originX: "center",
    originY: "center",
    fill: "#000000",
    stroke: undefined,
    strokeWidth: 0,
    globalCompositeOperation: "destination-out",
    excludeFromExport: true,
    selectable: false,
    evented: false,
  } as any);
}
const VIRTUAL_SIZE = 2000;
const PREVIEW_MULTIPLIER = 2; // 2× = ~600 dpi for a 70mm label

export async function saveDesign(
  input: SaveDesignInput
): Promise<SaveDesignResult> {
  const { canvas } = input;

  // 1. Capture LIVE canvas → PNG + JSON for the active side. Wrapped
  //    so a malformed canvas can't poison the whole save.
  let live: SidePayload | null = null;
  try {
    live = snapshotLive(
      canvas,
      input.lengthMm,
      input.widthMm,
      input.tagOrientation,
      input.backgroundColor,
      input.canvasShape,
      input.shapeModifiers
    );
  } catch (e) {
    console.warn("[saveDesign] live snapshot failed:", e);
  }

  // 2. If the product is two-sided AND the OTHER side has actual stored
  //    content, render it offscreen so the final payload always carries
  //    both faces. `snapshotFromStoredSnapshot` is null-safe and
  //    timeout-safe — it resolves to null on any problem rather than
  //    hanging the save flow.
  const otherStored =
    input.activeSide === "front" ? input.backDesign : input.frontDesign;
  const otherSide = input.supportsBackSide
    ? await snapshotFromStoredSnapshot(
        otherStored,
        input.canvasShape,
        input.shapeModifiers,
        getProductConfig(input.productSlug).visualGuides
      )
    : null;

  // Slot the two payloads into front / back so downstream uploads + URLs
  // are unambiguous regardless of which face the user was editing.
  const frontSide: SidePayload | null =
    input.activeSide === "front" ? live : otherSide;
  const backSide: SidePayload | null =
    input.activeSide === "back" ? live : otherSide;

  if (!isSupabaseConfigured()) {
    return saveLocally(frontSide, backSide, input);
  }
  try {
    const remote = await saveToSupabase(frontSide, backSide, input);
    if (remote) return remote;
    // saveToSupabase returned null → uploads couldn't go through.
    // Fall back to a local save so the user can still proceed.
    console.warn(
      "[trims-studio] Supabase upload returned no URLs, using localStorage"
    );
    return saveLocally(frontSide, backSide, input);
  } catch (e) {
    // saveToSupabase no longer throws on partial failure, but keep this
    // catch as a last-resort safety net — `saveLocally` always produces
    // a finalize URL, so the user is never stranded on "Saving…".
    console.warn(
      "[trims-studio] Supabase save threw unexpectedly, falling back to localStorage:",
      e
    );
    return saveLocally(frontSide, backSide, input);
  }
}

/* ------------------------------------------------------------------ */
/* Side snapshot helpers                                                */
/* ------------------------------------------------------------------ */

/* ----- Shape silhouette geometry (mirrors Workspace.tsx) ----------- */

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
    // TR + BR chamfered, left edge square.
    return [
      { x: left, y: top },
      { x: left + w - c, y: top },
      { x: left + w, y: top + c },
      { x: left + w, y: top + h - c },
      { x: left + w - c, y: top + h },
      { x: left, y: top + h },
    ];
  }
  // vertical — TL + TR chamfered, bottom edge square.
  return [
    { x: left + c, y: top },
    { x: left + w - c, y: top },
    { x: left + w, y: top + c },
    { x: left + w, y: top + h },
    { x: left, y: top + h },
    { x: left, y: top + c },
  ];
}

function starPolyPoints(
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
  const innerScale = 0.38;
  const n = Math.max(5, Math.floor(points));
  const total = n * 2;
  const out: { x: number; y: number }[] = [];
  const start = -Math.PI / 2;
  for (let i = 0; i < total; i++) {
    const a = start + (i * Math.PI) / n;
    const rx = i % 2 === 0 ? outerX : outerX * innerScale;
    const ry = i % 2 === 0 ? outerY : outerY * innerScale;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

/* ----- Premium hangtag silhouettes (mirror Workspace.tsx geometry) - */

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
      { x: left + w, y: top + h / 2 },
      { x: left + w - p, y: top + h },
      { x: left, y: top + h },
      { x: left, y: top },
      { x: left + w - p, y: top },
    ];
  }
  const p = Math.max(0, Math.min(pointHeight, w * 0.5, h * 0.45));
  return [
    { x: left + w / 2, y: top },
    { x: left + w, y: top + p },
    { x: left + w, y: top + h },
    { x: left, y: top + h },
    { x: left, y: top + p },
  ];
}

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
      { x: left + w, y: top + h / 2 },
      { x: left + w - p, y: top + h },
      { x: left + p, y: top + h },
      { x: left, y: top + h / 2 },
      { x: left + p, y: top },
      { x: left + w - p, y: top },
    ];
  }
  const p = Math.max(0, Math.min(pointHeight, w * 0.5, h * 0.4));
  return [
    { x: left + w / 2, y: top },
    { x: left + w, y: top + p },
    { x: left + w, y: top + h - p },
    { x: left + w / 2, y: top + h },
    { x: left, y: top + h - p },
    { x: left, y: top + p },
  ];
}

function flaredPath(w: number, h: number, waist: number): string {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const d = Math.max(0, Math.min(waist, h * 0.35));
    return [
      `M 0 0`,
      `Q ${w / 2} ${d} ${w} 0`,
      `L ${w} ${h}`,
      `Q ${w / 2} ${h - d} 0 ${h}`,
      "Z",
    ].join(" ");
  }
  const d = Math.max(0, Math.min(waist, w * 0.35));
  return [
    `M 0 0`,
    `L ${w} 0`,
    `Q ${w - d} ${h / 2} ${w} ${h}`,
    `L 0 ${h}`,
    `Q ${d} ${h / 2} 0 0`,
    "Z",
  ].join(" ");
}

function mixedCutRoundPath(w: number, h: number, corner: number): string {
  const isHorizontal = w > h;
  const c = Math.max(0, Math.min(corner, w * 0.4, h * 0.4));
  if (isHorizontal) {
    return [
      `M 0 ${c}`,
      `A ${c} ${c} 0 0 1 ${c} 0`,
      `L ${w - c} 0`,
      `L ${w} ${c}`,
      `L ${w} ${h - c}`,
      `L ${w - c} ${h}`,
      `L ${c} ${h}`,
      `A ${c} ${c} 0 0 1 0 ${h - c}`,
      "Z",
    ].join(" ");
  }
  return [
    `M ${c} 0`,
    `L ${w - c} 0`,
    `L ${w} ${c}`,
    `L ${w} ${h - c}`,
    `A ${c} ${c} 0 0 1 ${w - c} ${h}`,
    `L ${c} ${h}`,
    `A ${c} ${c} 0 0 1 0 ${h - c}`,
    `L 0 ${c}`,
    `L ${c} 0`,
    "Z",
  ].join(" ");
}

/* ----- Extended premium silhouettes (mirror Workspace.tsx) -------- */

function boutiquePath(w: number, h: number, depth: number): string {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const d = Math.max(0, Math.min(depth, w * 0.45));
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

function barrelPath(w: number, h: number, bulge: number): string {
  const isHorizontal = w > h;
  if (isHorizontal) {
    const d = Math.max(0, Math.min(bulge, w * 0.45));
    const k = d / 3;
    return [
      `M ${d} 0`,
      `L ${w - d} 0`,
      `C ${w + k} 0, ${w + k} ${h}, ${w - d} ${h}`,
      `L ${d} ${h}`,
      `C ${-k} ${h}, ${-k} 0, ${d} 0`,
      "Z",
    ].join(" ");
  }
  const d = Math.max(0, Math.min(bulge, h * 0.45));
  const k = d / 3;
  return [
    `M 0 ${d}`,
    `C 0 ${-k}, ${w} ${-k}, ${w} ${d}`,
    `L ${w} ${h - d}`,
    `C ${w} ${h + k}, 0 ${h + k}, 0 ${h - d}`,
    "Z",
  ].join(" ");
}

function pillPath(w: number, h: number): string {
  if (h >= w) {
    const r = w / 2;
    return [
      `M 0 ${r}`,
      `A ${r} ${r} 0 0 1 ${w} ${r}`,
      `L ${w} ${h - r}`,
      `A ${r} ${r} 0 0 1 0 ${h - r}`,
      "Z",
    ].join(" ");
  }
  const r = h / 2;
  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `A ${r} ${r} 0 0 1 ${w - r} ${h}`,
    `L ${r} ${h}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    "Z",
  ].join(" ");
}

function ticketPath(w: number, h: number, notch: number): string {
  const r = Math.max(0, Math.min(notch, w * 0.4, h * 0.4));
  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `Q ${w - r} ${r} ${w} ${r}`,
    `L ${w} ${h - r}`,
    `Q ${w - r} ${h - r} ${w - r} ${h}`,
    `L ${r} ${h}`,
    `Q ${r} ${h - r} 0 ${h - r}`,
    `L 0 ${r}`,
    `Q ${r} ${r} ${r} 0`,
    "Z",
  ].join(" ");
}

function topEdgeRoundedRectPath(
  w: number,
  h: number,
  r: number,
  tagOrientation: "vertical" | "horizontal"
): string {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (tagOrientation === "horizontal") {
    // TR + BR rounded; left edge square.
    return [
      `M 0 0`,
      `L ${w - radius} 0`,
      `A ${radius} ${radius} 0 0 1 ${w} ${radius}`,
      `L ${w} ${h - radius}`,
      `A ${radius} ${radius} 0 0 1 ${w - radius} ${h}`,
      `L 0 ${h}`,
      "Z",
    ].join(" ");
  }
  // vertical — TL + TR rounded; bottom edge square.
  return [
    `M ${radius} 0`,
    `L ${w - radius} 0`,
    `A ${radius} ${radius} 0 0 1 ${w} ${radius}`,
    `L ${w} ${h}`,
    `L 0 ${h}`,
    `L 0 ${radius}`,
    `A ${radius} ${radius} 0 0 1 ${radius} 0`,
    "Z",
  ].join(" ");
}

/**
 * Build a fabric.Object matching the active silhouette, positioned at the
 * VIRTUAL canvas's bleed rectangle. Returned object is `absolutePositioned`
 * so assigning it to `canvas.clipPath` clips the entire rendered output
 * to the cut-corner / round / oval / star silhouette — anything outside
 * the shape exports as alpha-zero.
 */
function buildShapeClipPath(
  canvasShape: CanvasShape,
  modifiers: ShapeModifiers,
  tagOrientation: "vertical" | "horizontal",
  lengthMm: number,
  widthMm: number
): fabric.Object {
  const bleedW = lengthMm * MM_TO_PX;
  const bleedH = widthMm * MM_TO_PX;
  const cx = VIRTUAL_SIZE / 2;
  const cy = VIRTUAL_SIZE / 2;
  const left = cx - bleedW / 2;
  const top = cy - bleedH / 2;

  const shortEdgeMm = Math.max(1, Math.min(lengthMm, widthMm));
  const maxModMm = shortEdgeMm * 0.4;
  const radiusPx =
    Math.max(0, Math.min(modifiers.cornerRadiusMm, maxModMm)) * MM_TO_PX;
  const slantPx =
    Math.max(0, Math.min(modifiers.slantLengthMm, maxModMm)) * MM_TO_PX;

  const opts: any = { absolutePositioned: true };

  switch (canvasShape) {
    case "round-corners": {
      const r = Math.max(0, Math.min(radiusPx, bleedW / 2, bleedH / 2));
      if (modifiers.cornersMode === "top") {
        const d = topEdgeRoundedRectPath(bleedW, bleedH, r, tagOrientation);
        return new fabric.Path(d, { left, top, ...opts });
      }
      return new fabric.Rect({
        left,
        top,
        width: bleedW,
        height: bleedH,
        rx: r,
        ry: r,
        ...opts,
      });
    }
    case "cut-corners":
      return new fabric.Polygon(
        cutCornerPoints(
          left,
          top,
          bleedW,
          bleedH,
          slantPx,
          modifiers.cornersMode,
          tagOrientation
        ),
        opts
      );
    case "oval":
      return new fabric.Ellipse({
        left,
        top,
        rx: bleedW / 2,
        ry: bleedH / 2,
        ...opts,
      });
    case "star":
      return new fabric.Polygon(
        starPolyPoints(left, top, bleedW, bleedH, modifiers.starPoints),
        opts
      );
    case "scalloped": {
      const r = Math.max(0, Math.min(radiusPx, bleedW / 2, bleedH / 2));
      return new fabric.Path(scallopedPath(bleedW, bleedH, r), {
        left,
        top,
        ...opts,
      });
    }
    case "pointed-top":
      return new fabric.Polygon(
        pointedTopPoints(left, top, bleedW, bleedH, slantPx),
        opts
      );
    case "hexagon-pointed":
      return new fabric.Polygon(
        hexagonPointedPoints(left, top, bleedW, bleedH, slantPx),
        opts
      );
    case "flared":
      return new fabric.Path(flaredPath(bleedW, bleedH, slantPx), {
        left,
        top,
        ...opts,
      });
    case "mixed-cut-round":
      return new fabric.Path(mixedCutRoundPath(bleedW, bleedH, slantPx), {
        left,
        top,
        ...opts,
      });
    case "boutique":
      return new fabric.Path(boutiquePath(bleedW, bleedH, slantPx), {
        left,
        top,
        ...opts,
      });
    case "arch":
      return new fabric.Path(archPath(bleedW, bleedH), {
        left,
        top,
        ...opts,
      });
    case "barrel":
      return new fabric.Path(barrelPath(bleedW, bleedH, slantPx), {
        left,
        top,
        ...opts,
      });
    case "pill":
      return new fabric.Path(pillPath(bleedW, bleedH), {
        left,
        top,
        ...opts,
      });
    case "ticket":
      return new fabric.Path(ticketPath(bleedW, bleedH, radiusPx), {
        left,
        top,
        ...opts,
      });
    case "rectangle":
    default:
      return new fabric.Rect({
        left,
        top,
        width: bleedW,
        height: bleedH,
        ...opts,
      });
  }
}

/**
 * Capture the LIVE canvas to a PNG.
 *
 * Sequence:
 *   1. Hide the guide layer (bleed/safety/holePunch).
 *   2. Set the canvas background to `transparent` and apply a canvas-level
 *      `clipPath` matching the product's silhouette.
 *   3. Export the trim rectangle.
 *   4. Restore EVERY mutated field so the editor isn't disrupted.
 *
 * The clipPath enforces the cut-corner / round / oval / star silhouette,
 * so areas outside the product shape land as alpha-zero in the PNG.
 */
function snapshotLive(
  canvas: fabric.Canvas,
  lengthMm: number,
  widthMm: number,
  tagOrientation: "vertical" | "horizontal",
  backgroundColor: string,
  canvasShape: CanvasShape,
  shapeModifiers: ShapeModifiers
): SidePayload {
  const safety = canvas.getObjects().find((o) => (o as any).id === "safety");
  const bleed = canvas.getObjects().find((o) => (o as any).id === "bleed");
  const hole = canvas.getObjects().find((o) => (o as any).id === "holePunch");
  // The hole punch is TWO objects:
  //   • `holePunch`         — the red dashed GUIDE ring (editor-only)
  //   • `holePunch-cutout`  — a destination-out disc that ERASES pixels
  //
  // For the print PNG we want the physical hole BAKED IN: hide the red
  // guide ring so the dashed line doesn't print, but keep the cutout
  // ACTIVE so the exported raster has a mathematically perfect native
  // transparent hole. The Finalize page then just displays the PNG —
  // no CSS overlay, no double hole.
  const holeCutout = canvas
    .getObjects()
    .find((o) => (o as any).id === "holePunch-cutout");

  // Cache every field we're about to mutate.
  const prevCanvasBg = (canvas as any).backgroundColor;
  const prevCanvasClip = (canvas as any).clipPath;
  const prevSafetyOpacity = safety?.opacity ?? 1;
  const prevBleedOpacity = bleed?.opacity ?? 1;
  const prevHoleVisible = hole?.visible ?? true;
  const prevCutoutVisible = holeCutout?.visible ?? true;

  // The red dashed "low quality" border is an EDITOR-ONLY marker. It
  // must never bake into the print PNG (a red line on the tag) nor
  // persist in the saved JSON. Strip it from every image before export
  // and restore afterward.
  const warnStroked: Array<{
    obj: any;
    stroke: any;
    strokeWidth: any;
    strokeDashArray: any;
  }> = [];
  canvas.getObjects().forEach((o: any) => {
    if (o.type === "image" && o.stroke === "#ef4444") {
      warnStroked.push({
        obj: o,
        stroke: o.stroke,
        strokeWidth: o.strokeWidth,
        strokeDashArray: o.strokeDashArray,
      });
      o.set({ stroke: undefined, strokeWidth: 0, strokeDashArray: undefined });
    }
  });

  // Hide the editor guides — canvas.bg + clipPath own the silhouette.
  // CRITICAL: hide ONLY the red guide ring; the destination-out cutout
  // STAYS visible so the transparent hole is baked into the PNG.
  if (safety) safety.set("opacity", 0);
  if (bleed) bleed.set("opacity", 0);
  if (hole) hole.set({ visible: false });
  if (holeCutout) holeCutout.set({ visible: true });
  // Paint the design's actual background colour INSIDE the clip; outside
  // the clip the canvas renders transparent (PNG alpha = 0).
  (canvas as any).backgroundColor = backgroundColor || "transparent";
  (canvas as any).clipPath = buildShapeClipPath(
    canvasShape,
    shapeModifiers,
    tagOrientation,
    lengthMm,
    widthMm
  );
  canvas.renderAll();

  const trimW = lengthMm * MM_TO_PX;
  const trimH = widthMm * MM_TO_PX;
  const cx = VIRTUAL_SIZE / 2;
  const cy = VIRTUAL_SIZE / 2;

  const previewDataUrl = canvas.toDataURL({
    format: "png",
    left: cx - trimW / 2,
    top: cy - trimH / 2,
    width: trimW,
    height: trimH,
    multiplier: PREVIEW_MULTIPLIER,
  });

  // Restore the live canvas exactly as it was — the red guide ring
  // becomes visible again so the editor shows the "don't place here" cue.
  (canvas as any).backgroundColor = prevCanvasBg;
  (canvas as any).clipPath = prevCanvasClip;
  if (safety) safety.set("opacity", prevSafetyOpacity);
  if (bleed) bleed.set("opacity", prevBleedOpacity);
  if (hole) hole.set({ visible: prevHoleVisible });
  if (holeCutout) holeCutout.set({ visible: prevCutoutVisible });
  canvas.renderAll();

  const fabricJson = canvas.toJSON([
    "id",
    "selectable",
    "evented",
    "excludeFromExport",
    "qrUrl",
    "qrFgColor",
    "qrBgColor",
    "barcodeText",
    "barColor",
    "barBgColor",
    "barHasBg",
  ]);

  // NOW restore the editor-only warning strokes (after BOTH the PNG and
  // the JSON were captured, so neither carries the red border).
  for (const w of warnStroked) {
    w.obj.set({
      stroke: w.stroke,
      strokeWidth: w.strokeWidth,
      strokeDashArray: w.strokeDashArray,
    });
  }
  if (warnStroked.length) canvas.renderAll();

  return {
    previewDataUrl,
    fabricJson,
    lengthMm,
    widthMm,
    tagOrientation,
    backgroundColor,
  };
}

/**
 * Render a SideSnapshot (stored in the Zustand store) onto an off-screen
 * fabric.StaticCanvas and export the PNG. Used to capture the side the
 * user ISN'T currently editing.
 *
 * Bulletproof guards:
 *   - Null / undefined / malformed `snap` resolves to `null` (skip side).
 *   - JSON parse failure resolves to `null` (don't block the save flow).
 *   - `loadFromJSON` is wrapped in a 6 s safety timeout so a stuck
 *     fabric callback can't hang the entire Continue button.
 */
function snapshotFromStoredSnapshot(
  snap: SideSnapshot | null | undefined,
  canvasShape: CanvasShape,
  shapeModifiers: ShapeModifiers,
  visualGuides?: VisualGuides
): Promise<SidePayload | null> {
  return new Promise((resolve) => {
    if (!snap || !snap.fabric) {
      resolve(null);
      return;
    }
    const lengthMm = snap.lengthMm > 0 ? snap.lengthMm : 0;
    const widthMm = snap.widthMm > 0 ? snap.widthMm : 0;
    if (lengthMm <= 0 || widthMm <= 0) {
      resolve(null);
      return;
    }

    let off: fabric.StaticCanvas | null = null;
    let resolved = false;
    const finish = (val: SidePayload | null) => {
      if (resolved) return;
      resolved = true;
      try {
        off?.dispose();
      } catch {
        /* swallow — disposal must never break the save flow */
      }
      resolve(val);
    };
    const timer = setTimeout(() => {
      console.warn(
        "[saveDesign] off-screen snapshot timed out, skipping this side"
      );
      finish(null);
    }, 6000);

    try {
      off = new fabric.StaticCanvas(null as any, {
        width: VIRTUAL_SIZE,
        height: VIRTUAL_SIZE,
      });
      const payload =
        typeof snap.fabric === "string"
          ? JSON.parse(snap.fabric)
          : { ...(snap.fabric || {}) };
      payload.background = snap.backgroundColor;
      off.loadFromJSON(payload, () => {
        try {
          // Strip any leaked guide objects (older saves sometimes
          // embedded them). Modern saves exclude guides via
          // `excludeFromExport`, but stay defensive.
          const leaked = off!
            .getObjects()
            .filter(
              (o: any) =>
                o.id === "safety" ||
                o.id === "holePunch" ||
                o.id === "holePunch-cutout" ||
                o.id === "bleed"
            );
          for (const o of leaked) off!.remove(o);
          // Paint the design's saved background INSIDE the silhouette;
          // OUTSIDE the canvas-level clipPath the export is alpha-zero.
          // This is the IDENTICAL pattern snapshotLive uses so both
          // faces produce PNGs with matching transparent cut-corners.
          (off as any).backgroundColor = snap.backgroundColor || "transparent";
          (off as any).clipPath = buildShapeClipPath(
            canvasShape,
            shapeModifiers,
            snap.tagOrientation,
            lengthMm,
            widthMm
          );
          // Re-create the destination-out cutout so the inactive side's
          // PNG bakes an IDENTICAL native transparent hole (the saved
          // JSON excludes guide objects, so we rebuild it from the
          // product's visual guides). Added LAST so it erases on top.
          const cutout = buildHoleCutout(
            lengthMm,
            widthMm,
            snap.tagOrientation,
            visualGuides
          );
          if (cutout) off!.add(cutout);
          off!.renderAll();
          const trimW = lengthMm * MM_TO_PX;
          const trimH = widthMm * MM_TO_PX;
          const cx = VIRTUAL_SIZE / 2;
          const cy = VIRTUAL_SIZE / 2;
          const previewDataUrl = off!.toDataURL({
            format: "png",
            left: cx - trimW / 2,
            top: cy - trimH / 2,
            width: trimW,
            height: trimH,
            multiplier: PREVIEW_MULTIPLIER,
          });
          // Strip the clipPath before dispose so the offscreen canvas
          // doesn't retain shape state if some future change reuses it.
          (off as any).clipPath = null;
          clearTimeout(timer);
          finish({
            previewDataUrl,
            fabricJson: payload,
            lengthMm,
            widthMm,
            tagOrientation: snap.tagOrientation,
            backgroundColor: snap.backgroundColor,
          });
        } catch (e) {
          console.warn("[saveDesign] off-screen render failed:", e);
          clearTimeout(timer);
          finish(null);
        }
      });
    } catch (e) {
      console.warn("[saveDesign] off-screen setup failed:", e);
      clearTimeout(timer);
      finish(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Supabase implementation                                              */
/* ------------------------------------------------------------------ */

/**
 * Push the design to Supabase. Resilient to partial failures: if PNG
 * uploads succeed but the row insert fails (e.g. the user's table is
 * missing the new two-sided columns), we still return a usable result
 * with the public PNG URLs so the storefront finalize page can render
 * the design. Returns `null` only when nothing could be persisted at
 * all (network down, bucket missing) — caller falls back to localStorage.
 */
async function saveToSupabase(
  frontSide: SidePayload | null,
  backSide: SidePayload | null,
  input: SaveDesignInput
): Promise<SaveDesignResult | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const designId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const folder = input.customerId ?? "anon";

  // Upload one side. NEVER throws — returns nulls on any failure so the
  // outer flow can still produce a finalize URL with whatever succeeded.
  const uploadSide = async (
    side: SidePayload,
    suffix: "front" | "back"
  ): Promise<{ url: string | null; path: string | null }> => {
    const path = `${folder}/${designId}-${suffix}.png`;
    try {
      const { error: uploadErr } = await supabase.storage
        .from(SUPABASE_DESIGNS_BUCKET)
        .upload(path, dataUrlToBlob(side.previewDataUrl), {
          contentType: "image/png",
          upsert: false,
        });
      if (uploadErr) {
        console.warn(
          `[saveDesign] storage upload (${suffix}) failed:`,
          uploadErr.message
        );
        return { url: null, path: null };
      }
      const { data: pub } = supabase.storage
        .from(SUPABASE_DESIGNS_BUCKET)
        .getPublicUrl(path);
      const url = pub?.publicUrl ?? null;
      if (!url) {
        console.warn(
          `[saveDesign] getPublicUrl returned no URL for ${suffix} (bucket "${SUPABASE_DESIGNS_BUCKET}")`
        );
        return { url: null, path: null };
      }
      return { url, path };
    } catch (e) {
      console.warn(`[saveDesign] upload (${suffix}) threw:`, e);
      return { url: null, path: null };
    }
  };

  let frontUrl: string | null = null;
  let frontPath: string | null = null;
  let backUrl: string | null = null;
  let backPath: string | null = null;

  if (frontSide) {
    const f = await uploadSide(frontSide, "front");
    frontUrl = f.url;
    frontPath = f.path;
  }
  if (backSide) {
    const b = await uploadSide(backSide, "back");
    backUrl = b.url;
    backPath = b.path;
  }

  // If BOTH uploads failed, treat as a Supabase outage and bail out so
  // the caller falls back to localStorage (where the dataURLs survive).
  if (frontSide && !frontUrl && backSide && !backUrl) {
    return null;
  }
  if (frontSide && !frontUrl && !backSide) {
    return null;
  }

  // Row insert. Wrapped in its own try/catch so a schema mismatch (e.g.
  // the user hasn't added the new fabric_json_back / preview_url_back
  // columns yet) doesn't abort the save — the PNGs are already public
  // and Shopify can render them.
  try {
    const row: Record<string, any> = {
      id: designId,
      customer_id: input.customerId,
      product_slug: input.productSlug,
      product_title: input.productTitle,
      length_mm: input.lengthMm,
      width_mm: input.widthMm,
      fabric_json: frontSide?.fabricJson ?? null,
      preview_url: frontUrl,
      preview_path: frontPath,
      work_id: input.workId,
      source_template_id: input.templateId,
      meta: {
        ua: navigator.userAgent,
        savedAt: new Date().toISOString(),
        canvasShape: input.canvasShape,
        shapeModifiers: input.shapeModifiers,
        supportsBackSide: input.supportsBackSide,
        activeSide: input.activeSide,
        // Per-side metadata so Load can reconstruct each face faithfully
        // (background colour + orientation + dims) without needing the
        // user to re-pick anything.
        frontSide: metaFromPayload(frontSide),
        backSide: metaFromPayload(backSide),
        // Mirror the back-side payload INSIDE meta so it survives even
        // when the dedicated columns don't exist yet.
        backFabricJson: backSide?.fabricJson ?? null,
        backPreviewUrl: backUrl,
        backPreviewPath: backPath,
      },
    };
    // Only include the new columns when we have data — keeps backwards
    // compatibility with single-sided tables (PostgREST ignores nulls
    // for absent columns but rejects unknown column NAMES).
    if (backSide) {
      row.fabric_json_back = backSide.fabricJson ?? null;
      row.preview_url_back = backUrl;
      row.preview_path_back = backPath;
    }

    const { error: insertErr } = await supabase
      .from("user_designs")
      .insert(row);

    if (insertErr) {
      console.warn(
        "[saveDesign] row insert failed (schema mismatch?). PNGs were uploaded; continuing with public URLs:",
        insertErr.message
      );
      // Retry once WITHOUT the two-sided columns, in case those are the
      // schema mismatch culprits. Storefront still gets the URLs.
      if (backSide) {
        try {
          const { error: retryErr } = await supabase
            .from("user_designs")
            .insert({
              id: designId,
              customer_id: input.customerId,
              product_slug: input.productSlug,
              product_title: input.productTitle,
              length_mm: input.lengthMm,
              width_mm: input.widthMm,
              fabric_json: frontSide?.fabricJson ?? null,
              preview_url: frontUrl,
              preview_path: frontPath,
              work_id: input.workId,
              source_template_id: input.templateId,
              meta: row.meta,
            });
          if (retryErr) {
            console.warn(
              "[saveDesign] retry insert without back columns also failed:",
              retryErr.message
            );
          }
        } catch (e) {
          console.warn("[saveDesign] retry insert threw:", e);
        }
      }
    }
  } catch (e) {
    console.warn("[saveDesign] row insert threw (continuing):", e);
  }

  return {
    designId,
    previewUrl: frontUrl,
    previewUrlBack: backUrl,
    finalizeUrl: buildFinalizeUrl({
      designId,
      previewUrl: frontUrl,
      previewUrlBack: backUrl,
      input,
    }),
    storedRemotely: true,
  };
}

/* ------------------------------------------------------------------ */
/* Local fallback                                                       */
/* ------------------------------------------------------------------ */

function saveLocally(
  frontSide: SidePayload | null,
  backSide: SidePayload | null,
  input: SaveDesignInput
): SaveDesignResult {
  const designId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id: designId,
    customer_id: input.customerId,
    product_slug: input.productSlug,
    product_title: input.productTitle,
    length_mm: input.lengthMm,
    width_mm: input.widthMm,
    fabric_json: frontSide?.fabricJson ?? null,
    fabric_json_back: backSide?.fabricJson ?? null,
    preview_url: frontSide?.previewDataUrl ?? null, // dev fallback: dataURL
    preview_url_back: backSide?.previewDataUrl ?? null,
    preview_path: null,
    preview_path_back: null,
    work_id: input.workId,
    source_template_id: input.templateId,
    canvas_shape: input.canvasShape,
    shape_modifiers: input.shapeModifiers,
    active_side: input.activeSide,
    supports_back_side: input.supportsBackSide,
    meta: {
      frontSide: metaFromPayload(frontSide),
      backSide: metaFromPayload(backSide),
    },
    saved_at: new Date().toISOString(),
  };
  try {
    localStorage.setItem(`trims:final:${designId}`, JSON.stringify(record));
  } catch (e) {
    console.warn("[trims-studio] localStorage write failed:", e);
  }
  return {
    designId,
    previewUrl: frontSide?.previewDataUrl ?? null,
    previewUrlBack: backSide?.previewDataUrl ?? null,
    finalizeUrl: buildFinalizeUrl({
      designId,
      previewUrl: null,
      previewUrlBack: null,
      input,
    }),
    storedRemotely: false,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = /data:([^;]+)/.exec(header);
  const mime = mimeMatch?.[1] ?? "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function buildFinalizeUrl(opts: {
  designId: string;
  previewUrl: string | null;
  previewUrlBack: string | null;
  input: SaveDesignInput;
}): string {
  const u = new URL(SHOPIFY_FINALIZE_URL);
  u.searchParams.set("design_id", opts.designId);

  // Append the public preview URL so the storefront's Liquid script
  // (`params.get('preview_url')`) can render the design image on the
  // /pages/finalize page. We only accept absolute http(s) URLs — data
  // URIs would explode the URL size, and relative paths can't be
  // displayed by Shopify cross-domain. `URLSearchParams.set` percent-
  // encodes the value automatically, so `:` and `/` are safe.
  if (opts.previewUrl && /^https?:\/\//i.test(opts.previewUrl)) {
    u.searchParams.set("preview_url", opts.previewUrl);
  } else if (opts.previewUrl) {
    console.warn(
      "[trims-studio] previewUrl is not an HTTP(S) URL; skipping `preview_url` param on the finalize redirect. " +
        "This usually means Supabase wasn't configured at save time and the save fell back to localStorage. " +
        `Got: ${opts.previewUrl.slice(0, 80)}…`
    );
  } else {
    console.warn(
      "[trims-studio] No previewUrl available for the finalize redirect. " +
        "The /pages/finalize page won't be able to render the design image."
    );
  }

  // Two-sided support — pin the back-side PNG to the same redirect so the
  // storefront can render both faces. Storefront should accept
  // `preview_url_back` (preferred) or `preview_url2` (legacy alias).
  if (opts.previewUrlBack && /^https?:\/\//i.test(opts.previewUrlBack)) {
    u.searchParams.set("preview_url_back", opts.previewUrlBack);
  }

  if (opts.input.productSlug)
    u.searchParams.set("product", opts.input.productSlug);
  u.searchParams.set("length", String(opts.input.lengthMm));
  u.searchParams.set("width", String(opts.input.widthMm));
  if (opts.input.customerId)
    u.searchParams.set("customer_id", opts.input.customerId);
  // Tag orientation — kept as informative metadata for the production
  // team even though the storefront preview no longer reads it.
  u.searchParams.set("orientation", opts.input.tagOrientation);
  // Shape blueprint for the production team — pinned to the Shopify
  // cart payload so the printer/cutter receives the exact silhouette.
  u.searchParams.set("shape", opts.input.canvasShape);
  if (opts.input.canvasShape === "round-corners") {
    u.searchParams.set(
      "corner_radius_mm",
      String(opts.input.shapeModifiers.cornerRadiusMm)
    );
    u.searchParams.set("corners_mode", opts.input.shapeModifiers.cornersMode);
  } else if (opts.input.canvasShape === "cut-corners") {
    u.searchParams.set(
      "slant_length_mm",
      String(opts.input.shapeModifiers.slantLengthMm)
    );
    u.searchParams.set("corners_mode", opts.input.shapeModifiers.cornersMode);
  } else if (opts.input.canvasShape === "star") {
    u.searchParams.set(
      "star_points",
      String(opts.input.shapeModifiers.starPoints)
    );
  }

  const out = u.toString();
  // Make the final URL visible in the console so the merchant can
  // confirm `preview_url` is present (or spot when it's missing).
  console.info("[trims-studio] finalize redirect →", out);
  return out;
}
