import { create } from "zustand";
import type { fabric } from "fabric";
import type { StudioMode } from "@/lib/urlParams";
import { history } from "@/lib/historyAccessor";
import {
  getProductConfig,
  type ProductConfig,
} from "@/config/productConfig";
import { buildBarcodeApiUrl } from "@/lib/barcode";

/**
 * User-selectable silhouette for the active product. Replaces the old
 * static `productConfig.canvasClipShape` for the bleed/safety geometry.
 * The product config still seeds the default — but it's no longer the
 * single source of truth.
 */
export type CanvasShape =
  | "rectangle"
  | "round-corners"
  | "cut-corners"
  | "oval"
  | "star"
  // ---- Premium hangtag silhouettes ----
  /** All 4 corners have a quarter-circle CUT OUT (concave arcs). */
  | "scalloped"
  /** Triangular apex at the top; bottom is a square rectangle. */
  | "pointed-top"
  /** 6-sided polygon — single apex on top AND bottom, straight sides. */
  | "hexagon-pointed"
  /** Top + bottom straight; left + right curve inward (waist / bell). */
  | "flared"
  /** Angled cut top corners + rounded arc bottom corners. */
  | "mixed-cut-round"
  // ---- Premium hangtag silhouettes (extended set) ----
  /** Vintage ornate top — concave dips flank a convex central bump. */
  | "boutique"
  /** Tombstone — square bottom, perfect semi-circle top arch. */
  | "arch"
  /** Bent oval — straight vertical sides, convex bulging top + bottom. */
  | "barrel"
  /** Capsule — short edges replaced entirely by 180° semi-circles. */
  | "pill"
  /** Cinema-ticket — small concave semi-circle bites at the 4 vertices. */
  | "ticket";

export interface ShapeModifiers {
  /** Round-corners: corner radius in mm. */
  cornerRadiusMm: number;
  /** Cut-corners: chamfer length in mm (depth of the diagonal cut). */
  slantLengthMm: number;
  /** Star: number of points (5+). */
  starPoints: number;
  /**
   * Which corners receive the round / chamfer treatment. `'top'` matches
   * the standard luggage-tag profile (TL + TR only, bottom stays square).
   * `'all'` rounds/cuts every corner.
   */
  cornersMode: "top" | "all";
}

export const DEFAULT_SHAPE_MODIFIERS: ShapeModifiers = {
  cornerRadiusMm: 4,
  slantLengthMm: 12,
  starPoints: 5,
  cornersMode: "top",
};

/**
 * Loose shape of a saved-design row as it returns from Supabase or
 * localStorage. Every field is optional because the persistence layer
 * has gone through several iterations — older rows lack many fields.
 */
export interface SavedDesignRow {
  id?: string;
  length_mm?: number;
  width_mm?: number;
  fabric_json?: any;
  fabric_json_back?: any | null;
  preview_url?: string | null;
  preview_url_back?: string | null;
  /** Optional metadata bag — may contain per-side info + the legacy
   *  `backFabricJson` mirror. See saveDesign.ts. */
  meta?: Record<string, any> | null;
}

/**
 * Per-side persistence payload. Bundles every store field that lives
 * OUTSIDE the fabric JSON so a Front ↔ Back switch (or an undo) can
 * faithfully restore the exact look the side had at snapshot time.
 *
 *  - `fabric`          → raw `canvas.toJSON([...])` payload
 *  - `backgroundColor` → bleed/templateBg fill (excludeFromExport)
 *  - `tagOrientation`  → vertical / horizontal hole-edge state
 *  - `lengthMm / widthMm` → bleed dims at snapshot time (sides may
 *    legitimately have different aspect ratios when the user rotates
 *    the front but not yet the back)
 */
export interface SideSnapshot {
  fabric: any;
  backgroundColor: string;
  tagOrientation: "vertical" | "horizontal";
  lengthMm: number;
  widthMm: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Module-scoped timer for the auto-hide of `canvasWarning`. Kept
 * outside the zustand state so React re-renders don't reset it, and so
 * a re-trigger (`setCanvasWarning("...")` again) cleanly cancels the
 * pending hide and starts a new 5-second window.
 */
let warningHideTimer: number | null = null;

/**
 * Whether the active product supports the half-flip orchestration
 * (i.e. the editor will run the 0→90→-90→0 canvas animation). When
 * false, `setActiveSide` falls back to an immediate JSON load so the
 * back side still shows up.
 */
function productSupportsHalfFlip(s: CanvasStoreState): boolean {
  return !!s.productConfig?.supportsBackSide;
}

/**
 * Mirror of the live-canvas re-centring math in `toggleOrientation`,
 * but applied to a STORED side snapshot (fabric JSON). Used to keep the
 * inactive side coherent with the user's orientation swap so that when
 * they flip, the back face slots into the new bleed without distortion.
 *
 * Mutates a CLONE — the original snapshot is left untouched.
 */
function rotateSnapshotOrientation(
  snap: SideSnapshot,
  oldLengthMm: number,
  oldWidthMm: number,
  newLengthMm: number,
  newWidthMm: number
): SideSnapshot {
  const MM_PX = 10;
  const VIRTUAL = 2000;
  const vcx = VIRTUAL / 2;
  const vcy = VIRTUAL / 2;
  const oldBleedW = oldLengthMm * MM_PX;
  const oldBleedH = oldWidthMm * MM_PX;
  const newBleedW = newLengthMm * MM_PX;
  const newBleedH = newWidthMm * MM_PX;
  const oldLeft = vcx - oldBleedW / 2;
  const oldTop = vcy - oldBleedH / 2;
  const newLeft = vcx - newBleedW / 2;
  const newTop = vcy - newBleedH / 2;

  // Deep-clone the fabric payload so we never mutate a payload the
  // caller might still be reading.
  const rawFabric =
    typeof snap.fabric === "string"
      ? safeParseJson(snap.fabric)
      : snap.fabric;
  const cloned: any =
    rawFabric && typeof rawFabric === "object"
      ? JSON.parse(JSON.stringify(rawFabric))
      : { objects: [] };

  const objects: any[] = Array.isArray(cloned.objects) ? cloned.objects : [];
  for (const o of objects) {
    if (!o || typeof o !== "object") continue;
    // Skip guides / bleed / safety / hole — they're rebuilt by the
    // guide pass on load.
    if (o.excludeFromExport) continue;
    // The fabric JSON stores `left` / `top` as the object's TOP-LEFT
    // anchor in canvas pixels (after any originX/Y is applied). For
    // re-centring we approximate the object's own centre as
    // (left + width*scaleX/2, top + height*scaleY/2). When originX/Y
    // is "center", left/top already point at the centre.
    const left = Number(o.left) || 0;
    const top = Number(o.top) || 0;
    const width = Number(o.width) || 0;
    const height = Number(o.height) || 0;
    const scaleX = Number(o.scaleX) || 1;
    const scaleY = Number(o.scaleY) || 1;
    const isCentre = o.originX === "center" && o.originY === "center";
    const oldCx = isCentre ? left : left + (width * scaleX) / 2;
    const oldCy = isCentre ? top : top + (height * scaleY) / 2;
    const relX = clamp01((oldCx - oldLeft) / Math.max(1, oldBleedW));
    const relY = clamp01((oldCy - oldTop) / Math.max(1, oldBleedH));
    const newCx = newLeft + relX * newBleedW;
    const newCy = newTop + relY * newBleedH;
    const dx = newCx - oldCx;
    const dy = newCy - oldCy;
    if (dx !== 0 || dy !== 0) {
      o.left = left + dx;
      o.top = top + dy;
    }
  }

  return {
    ...snap,
    fabric: cloned,
    lengthMm: newLengthMm,
    widthMm: newWidthMm,
    tagOrientation:
      snap.tagOrientation === "vertical" ? "horizontal" : "vertical",
  };
}

function safeParseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return { objects: [] };
  }
}



/** Tolerant JSON parse — accepts an object verbatim or parses a string. */
function parseJsonLoose(raw: any): any | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Return the first non-empty string from the candidates list. */
function firstString(...candidates: any[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

function toFiniteNumber(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Sniff the bleed rectangle's fill out of a fabric JSON payload. The
 *  bleed is `excludeFromExport`, so it usually ISN'T in the saved JSON
 *  — but older templates / direct toJSON exports might include it. */
function bleedFillFromJson(json: any): string | null {
  if (!json || !Array.isArray(json.objects)) return null;
  const bleed = json.objects.find((o: any) => o && o.id === "bleed");
  if (bleed && typeof bleed.fill === "string") return bleed.fill;
  return null;
}

/** Translate the legacy productConfig `canvasClipShape` into a CanvasShape. */
export function shapeFromProductConfig(c: ProductConfig): CanvasShape {
  switch (c.canvasClipShape) {
    case "cut-corners":
      return "cut-corners";
    case "circle":
      return "oval";
    case "arch":
      // Arch isn't user-selectable; fall back to round-corners for now.
      return "round-corners";
    case "rectangle":
    default:
      return "rectangle";
  }
}

/**
 * Tool rail identifiers — drives which side panel is open.
 * `null` means no panel is open.
 */
export type ToolKey =
  | "product"
  | "text"
  | "uploads"
  | "graphics"
  | "background"
  | "more"
  | null;

/**
 * Type discriminator for the currently selected canvas object.
 * Drives which contextual toolbar variant is rendered.
 */
export type SelectedItemType =
  | "text"
  | "image"
  | "qr"
  | "barcode"
  | "shape"
  | "group"
  | "activeSelection"
  | "unknown";

/**
 * Mirror of the active fabric object's editable properties.
 *
 * IMPORTANT: every field is non-nullable. The Zustand updater fills safe
 * defaults so contextual UI components can render without `?.` chains or
 * conditional guards — preventing the "white screen of death" when a fresh
 * object is added and React tries to render the toolbar before fabric has
 * finished initialising the object's properties.
 */
export interface SelectedItemState {
  type: SelectedItemType;
  text: string;
  fontSize: number;
  fill: string;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  textAlign: string;
  opacity: number;
  angle: number;
  lineHeight: number;
  charSpacing: number;
  locked: boolean;
  /** Whether the active object has a non-empty drop shadow. */
  hasShadow: boolean;
  /** Stroke width in canvas pixels. 0 means no stroke. */
  strokeWidth: number;
  /** Whether IText.underline is on. */
  underline: boolean;
  /** QR code colours (only meaningful when type === "qr"). */
  qrFgColor: string;
  qrBgColor: string;
  /** Barcode colours (only meaningful when type === "barcode"). */
  barColor: string;
  barBgColor: string;
  /** Whether the barcode has a solid background (false = transparent). */
  barHasBg: boolean;
  /**
   * For images, true when the rendered DPI dips below the safe
   * print-quality threshold (~150 DPI). Drives the red sidebar banner
   * + Replace Image CTA so the user can swap the asset before order.
   */
  isLowRes: boolean;
  /**
   * For images, the UNION quality flag: low DPI (pixel stretch) OR
   * optical blur (out of focus). Drives the toolbar warning icon +
   * "Enhance / Sharpen" affordance.
   */
  isBlurry: boolean;
}

const DEFAULT_SELECTED: SelectedItemState = {
  type: "unknown",
  text: "",
  fontSize: 20,
  fill: "#000000",
  fontFamily: "Arimo",
  fontWeight: "normal",
  fontStyle: "normal",
  textAlign: "left",
  opacity: 1,
  angle: 0,
  lineHeight: 1.16,
  charSpacing: 0,
  locked: false,
  hasShadow: false,
  strokeWidth: 0,
  underline: false,
  qrFgColor: "#000000",
  qrBgColor: "#ffffff",
  barColor: "#000000",
  barBgColor: "#ffffff",
  barHasBg: true,
  isLowRes: false,
  isBlurry: false,
};

export interface CanvasStoreState {
  // ---- canvas instance + dimensions ----
  canvas: fabric.Canvas | null;
  setCanvas: (c: fabric.Canvas | null) => void;

  /**
   * Bleed dimensions in mm — treated as the master size of the design.
   *
   * Naming follows the trims.in product convention rather than the canvas
   * convention: `length` is the long (X-axis) dimension, `width` is the
   * short (Y-axis) dimension.
   *
   * The Safe Area is implicit: 2 mm inset on every edge, i.e.
   *   safeLengthMm = canvasLengthMm - 4
   *   safeWidthMm  = canvasWidthMm  - 4
   */
  canvasLengthMm: number;
  canvasWidthMm: number;
  setCanvasSize: (lengthMm: number, widthMm: number) => void;

  /** Aspect-ratio lock for the Product Options panel. */
  isAspectRatioLocked: boolean;
  setAspectRatioLocked: (locked: boolean) => void;
  /** Cached length/width ratio used to derive the partner field. */
  aspectRatio: number;
  setAspectRatio: (ratio: number) => void;
  /**
   * Update one dimension while respecting the lock. When locked, the
   * partner field is recomputed from `aspectRatio` and rounded to 1mm.
   */
  updateLength: (lengthMm: number) => void;
  updateWidth: (widthMm: number) => void;

  /**
   * Swap the active length and width — flips between landscape and
   * portrait orientation in one click. The dim-change effect in
   * Workspace will rescale user objects accordingly. Snapshots history.
   */
  toggleOrientation: () => void;

  /**
   * Physical tag orientation — drives which edge carries the hole punch
   * and the shape modifications (cuts / arcs).
   *
   *  - `vertical`   → hole on the TOP edge (default luggage tag)
   *  - `horizontal` → hole on the RIGHT edge (rotated 90°)
   *
   * Toggled together with the L/W swap by `toggleOrientation`. User
   * objects keep their angle (text stays upright), only their X/Y are
   * clamped to the new bleed bounds.
   */
  tagOrientation: "vertical" | "horizontal";
  setTagOrientation: (o: "vertical" | "horizontal") => void;

  /** Product display title (from URL `product_title=` or fallback). */
  productTitle: string;
  setProductTitle: (t: string) => void;

  /** Stable product slug from `product=` (e.g. `woven-labels`). */
  productSlug: string | null;
  setProductSlug: (s: string | null) => void;

  /**
   * Active product configuration (tools, default dims, visual guides,
   * clip shape). Drives the canvas engine + sidebar so the Studio
   * adapts per product without hard-coded assumptions.
   */
  productConfig: ProductConfig;
  setProductConfig: (c: ProductConfig) => void;

  /** Shopify customer.id when the storefront passes it. `null` = anonymous. */
  customerId: string | null;
  setCustomerId: (id: string | null) => void;

  /** Auto-save identifier; mirrored to `?workId=` in the URL. */
  workId: string | null;
  setWorkId: (w: string | null) => void;
  /** Wall-clock timestamp of the last successful auto-save. */
  lastSavedAt: number | null;
  markSaved: () => void;

  /** Studio launch mode (template / upload / blank). */
  mode: StudioMode;
  setMode: (m: StudioMode) => void;

  /** Template metadata — meaningful when `mode === "template"`. */
  templateId: string | null;
  templateName: string | null;
  templateImageUrl: string | null;
  templateJsonUrl: string | null;
  setTemplateMeta: (meta: {
    id: string | null;
    name: string | null;
    imageUrl: string | null;
    jsonUrl: string | null;
  }) => void;
  /** Backwards-compat single-field setter for the JSON URL. */
  setTemplateJsonUrl: (u: string | null) => void;

  // ---- UI state ----
  activeTool: ToolKey;
  /** Toggle a tool tab (clicking the active one closes it). */
  setActiveTool: (t: ToolKey) => void;
  /**
   * Deterministically OPEN a tool tab (never toggles). Used by the
   * guided tour (to step through panels) and the auto-open-on-text-
   * select behaviour, where toggling would be wrong.
   */
  openTool: (t: NonNullable<ToolKey>) => void;

  zoom: number; // 1 = fit
  setZoom: (z: number) => void;

  /** Background color of the trim card. */
  backgroundColor: string;
  setBackgroundColor: (c: string) => void;

  /** Most-recently used custom colours (max 8, MRU order). */
  recentColors: string[];
  addRecentColor: (c: string) => void;

  /** Whether bleed/safe guides are visible (Settings popover toggle). */
  showGuides: boolean;
  setShowGuides: (b: boolean) => void;

  /** Whether the user is editing a design loaded from "Recent designs". */
  isRecentDesignLoaded: boolean;
  setRecentDesignLoaded: (loaded: boolean) => void;
  /** Snapshot of the original `?…` query string at boot, for "Revert". */
  originalUrlSearch: string;
  setOriginalUrlSearch: (s: string) => void;

  /** Centered Upload modal open state (used in mode=upload). */
  uploadModalOpen: boolean;
  setUploadModalOpen: (b: boolean) => void;

  /**
   * Internal flag set by `designOps.loadJson` so the dim-change effect
   * SKIPS its auto-rescale on the next dimension change. Loaded designs
   * carry positions that are already valid for the target bleed; running
   * the dim-effect's per-axis scale on top of them double-shrinks. The
   * flag is consumed (set back to false) after a single dim change.
   */
  _skipNextDimRescale: boolean;
  _setSkipNextDimRescale: (b: boolean) => void;

  // ---- selection state ----
  selected: SelectedItemState | null;
  /**
   * Sync the active object's editable properties into the store.
   * Pass `null` to clear (selection cleared).
   * SAFE-DEFAULTS: we coerce every property so contextual UI never crashes.
   */
  updateActiveObject: (obj: fabric.Object | null) => void;

  /** Mutate a single property on the currently selected fabric object + sync. */
  patchActive: (patch: Partial<SelectedItemState>) => void;

  /** Regenerate the active QR image with new fg/bg colours (async). */
  updateQrColors: (fg?: string, bg?: string) => Promise<void>;

  /**
   * Re-fetch the active barcode from the bwip-js API with new bar/text
   * colour and/or background colour, then swap the fabric.Image source.
   * `bg === "transparent"` omits the API background param for a fully
   * transparent backdrop.
   */
  updateBarcodeColors: (opts: {
    barColor?: string;
    bgColor?: string;
    hasBg?: boolean;
  }) => Promise<void>;

  // ---- history (Undo/Redo) ----
  canUndo: boolean;
  canRedo: boolean;
  setHistoryFlags: (canUndo: boolean, canRedo: boolean) => void;

  // ---- dynamic canvas shape (Hangtag silhouettes etc.) ----
  /**
   * Active product silhouette. Dynamic now — user can switch from the
   * Product panel at any time. Defaults are seeded from
   * `productConfig.canvasClipShape` on product load but no longer baked in.
   */
  canvasShape: CanvasShape;
  setCanvasShape: (s: CanvasShape) => void;
  /**
   * Per-shape physical measurements (mm). Decoupled from the shape itself
   * so flipping between modes preserves the previous slider value.
   */
  shapeModifiers: ShapeModifiers;
  updateShapeModifiers: (patch: Partial<ShapeModifiers>) => void;

  /**
   * Transient top-right warning shown while the user is moving / scaling
   * an object outside the safe area, over the hole punch, or when the
   * image they're handling is too low-resolution to print cleanly.
   * `null` hides the toast. Auto-clears 5s after the last set unless
   * a follow-up event re-triggers the warning (the timeout is reset
   * inside `setCanvasWarning`).
   */
  canvasWarning: string | null;
  /**
   * Monotonic counter bumped on EVERY `setCanvasWarning(msg)` call with
   * a non-null message. The toast keys on this so an identical
   * consecutive warning (e.g. two blurry uploads in a row) still
   * replays the slide-in animation — `key={message}` alone wouldn't
   * change when the string is the same.
   */
  canvasWarningId: number;
  /**
   * Visual style of the toast: 'warning' (amber/red — out-of-bounds,
   * low-res, errors) or 'success' (green — e.g. back side added).
   */
  canvasWarningType: "warning" | "success";
  setCanvasWarning: (msg: string | null, type?: "warning" | "success") => void;

  // ---- preview ----
  previewOpen: boolean;
  setPreviewOpen: (b: boolean) => void;

  // ---- interactive onboarding tour ----
  /** Whether the live element-highlight tour overlay is showing. */
  isTourActive: boolean;
  setTourActive: (b: boolean) => void;

  /**
   * Preview MODE — distinct from `previewOpen` (the modal). When `true`,
   * the workspace hides editing guides, locks all objects, and overlays
   * a material texture on the canvas wrapper so the design reads as
   * physically woven / printed.
   */
  previewMode: boolean;
  setPreviewMode: (b: boolean) => void;

  /**
   * Full-screen 3D flip preview modal. Shows snapshots of the front /
   * back designs with the texture overlay applied; user flips between
   * them with a `rotateY(180deg)` CSS animation.
   */
  previewFlipOpen: boolean;
  setPreviewFlipOpen: (b: boolean) => void;

  // ---- multi-sided designs (front / back) ----
  /** Which face the canvas is currently editing. */
  activeSide: "front" | "back";
  /** Snapshot of the front-side fabric canvas + paint state. */
  frontDesign: SideSnapshot | null;
  /** Snapshot of the back-side fabric canvas + paint state. */
  backDesign: SideSnapshot | null;
  /**
   * Switch to the opposite side. Implementation:
   *   1. Serialize the current canvas to JSON and stash it under the
   *      current side's slot (frontDesign / backDesign).
   *   2. Flip `activeSide`.
   *   3. Load the target side's JSON into the canvas (or clear all
   *      user content if no snapshot exists yet).
   */
  setActiveSide: (side: "front" | "back") => void;

  /**
   * Load the snapshot for `activeSide` into the live fabric canvas.
   * Used by Workspace.tsx's half-flip orchestration to defer the
   * content swap until the canvas is edge-on (rotated 90°). Also
   * called directly by single-faced products that skip the flip.
   */
  loadActiveSideJson: () => void;

  /** Whether the "Change the back" chooser modal is open. */
  backChooserOpen: boolean;
  setBackChooserOpen: (b: boolean) => void;
  /**
   * Global "remove back design?" confirmation modal. Opened from the
   * SideToggle trash button and from the Next-step back check modal.
   */
  confirmDeleteBackOpen: boolean;
  setConfirmDeleteBackOpen: (b: boolean) => void;
  /**
   * Global "Next" interception modal shown for 2-sided designs so the
   * user confirms the (chargeable) back side before proceeding.
   */
  nextBackCheckOpen: boolean;
  setNextBackCheckOpen: (b: boolean) => void;

  /**
   * Restore a previously-saved design (both sides + paint + orientation
   * + dims) onto the live canvas. Used by the "Recent designs" picker.
   *
   * Accepts a loose row shape so both Supabase and localStorage records
   * (which use slightly different field names) can be passed verbatim.
   */
  loadDesign: (row: SavedDesignRow) => Promise<void>;
  /**
   * Build the back-side design from one of three starting points and
   * switch the canvas to the back side. Used by the "Change the back"
   * modal.
   *   - 'duplicate' → copy front JSON to back, then switch
   *   - 'blank'     → switch to back with an empty canvas
   *   - 'upload'    → switch to back blank + open the upload modal
   */
  initBackDesign: (kind: "duplicate" | "blank" | "upload") => void;
  /**
   * Discard the back-side design completely. Clears `backDesign` and
   * forces `activeSide` back to "front", repainting the canvas with the
   * front snapshot so the user is never left staring at an empty back
   * face after deletion.
   */
  clearBackDesign: () => void;
  /** Direct setters (used by save-design loaders that hydrate both sides). */
  setFrontDesign: (snap: SideSnapshot | null) => void;
  setBackDesign: (snap: SideSnapshot | null) => void;
}

/**
 * Resolve a property to a string with a fallback. Fabric sometimes returns
 * gradients/patterns instead of plain strings for `fill` — we coerce to a
 * safe string so React doesn't choke when binding it to <input type="color">.
 */
function safeString(v: unknown, fallback: string): string {
  if (typeof v === "string" && v.length > 0) return v;
  return fallback;
}

function safeNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function classifyType(obj: fabric.Object): SelectedItemType {
  const t = obj.type ?? "";
  if (t === "i-text" || t === "textbox" || t === "text") return "text";
  // QR images are tagged with `qrUrl` at creation time so we can route
  // their colour pickers through the regenerator instead of the generic
  // fill/stroke path.
  if (t === "image" && (obj as any).qrUrl) return "qr";
  // Barcodes are tagged with `barcodeText` so their colour pickers route
  // through the barcode regenerator (re-fetch from the bwip-js API).
  if (t === "image" && (obj as any).barcodeText) return "barcode";
  if (t === "image") return "image";
  if (
    t === "rect" ||
    t === "circle" ||
    t === "triangle" ||
    t === "polygon" ||
    t === "path" ||
    t === "line"
  )
    return "shape";
  if (t === "group") return "group";
  if (t === "activeSelection") return "activeSelection";
  return "unknown";
}

/**
 * "Hollow" shape detector. The Graphics panel ships outline variants of
 * every fillable shape with `fill: 'transparent'` + `stroke: <color>`.
 * For these objects, the color picker should drive `stroke`, not `fill`,
 * otherwise it appears to do nothing.
 */
function isHollowShape(obj: any): boolean {
  if (!obj) return false;
  const t = obj.type ?? "";
  if (t === "i-text" || t === "textbox" || t === "text" || t === "image") {
    return false;
  }
  const fill = obj.fill;
  const stroke = obj.stroke;
  const fillIsEmpty =
    fill == null || fill === "" || fill === "transparent" || fill === "rgba(0,0,0,0)";
  return fillIsEmpty && typeof stroke === "string" && stroke.length > 0;
}

/**
 * Decide whether the colour picker should write to `fill` or `stroke` for
 * a given fabric object. Cases that drive `stroke`:
 *   - Line:  has no fill — stroke IS the visible colour.
 *   - Path:  many path templates (icons, hand-drawn outlines) ship with
 *            empty fill; the visible colour is the stroke.
 *   - Hollow shape: explicitly transparent fill + a stroke.
 *   - Group of stroke-driven children (e.g. tables): route to stroke and
 *            we'll fan out to each child in `patchActive`.
 * Everything else (solid rect/circle/triangle, text, image) writes to fill.
 */
function colorTarget(obj: any): "fill" | "stroke" {
  if (!obj) return "fill";
  const t = obj.type ?? "";
  if (t === "line") return "stroke";
  if (t === "path") {
    const fill = obj.fill;
    const fillEmpty =
      fill == null ||
      fill === "" ||
      fill === "transparent" ||
      fill === "rgba(0,0,0,0)";
    if (fillEmpty) return "stroke";
  }
  if (isHollowShape(obj)) return "stroke";
  if (t === "group" && Array.isArray(obj._objects) && obj._objects.length > 0) {
    const allStroke = obj._objects.every(
      (c: any) => colorTarget(c) === "stroke"
    );
    if (allStroke) return "stroke";
  }
  return "fill";
}

export const useCanvasStore = create<CanvasStoreState>((set, get) => ({
  canvas: null,
  setCanvas: (c) => set({ canvas: c }),

  canvasLengthMm: 90,
  canvasWidthMm: 50,
  setCanvasSize: (lengthMm, widthMm) =>
    set({
      canvasLengthMm: lengthMm,
      canvasWidthMm: widthMm,
      // Refresh the cached ratio whenever the dimensions are reseeded.
      aspectRatio: lengthMm / widthMm,
    }),

  isAspectRatioLocked: true,
  setAspectRatioLocked: (locked) => set({ isAspectRatioLocked: locked }),
  aspectRatio: 90 / 50,
  setAspectRatio: (ratio) => set({ aspectRatio: ratio }),
  updateLength: (lengthMm) => {
    const s = get();
    const safeLength = Math.max(10, Math.round(lengthMm));
    if (s.isAspectRatioLocked && s.aspectRatio > 0) {
      const safeWidth = Math.max(10, Math.round(safeLength / s.aspectRatio));
      set({ canvasLengthMm: safeLength, canvasWidthMm: safeWidth });
    } else {
      set({ canvasLengthMm: safeLength });
    }
  },
  updateWidth: (widthMm) => {
    const s = get();
    const safeWidth = Math.max(10, Math.round(widthMm));
    if (s.isAspectRatioLocked && s.aspectRatio > 0) {
      const safeLength = Math.max(10, Math.round(safeWidth * s.aspectRatio));
      set({ canvasLengthMm: safeLength, canvasWidthMm: safeWidth });
    } else {
      set({ canvasWidthMm: safeWidth });
    }
  },

  toggleOrientation: () => {
    const s = get();
    const oldLengthMm = s.canvasLengthMm;
    const oldWidthMm = s.canvasWidthMm;
    const newLengthMm = oldWidthMm;
    const newWidthMm = oldLengthMm;
    const canvas = s.canvas;

    // The Workspace dim-change effect listens to canvasLengthMm /
    // canvasWidthMm and PER-AXIS rescales every object (scaleX *= newL/oldL,
    // scaleY *= newW/oldW). On an orientation swap that's a 1.8× stretch
    // on one axis and a 0.55× squish on the other — exactly the warping
    // the user reported. Set _skipNextDimRescale BEFORE we flip the
    // dimensions so the auto-rescale never runs for this dim change.
    if (canvas) {
      s._setSkipNextDimRescale(true);
    }

    set({
      canvasLengthMm: newLengthMm,
      canvasWidthMm: newWidthMm,
      // Aspect ratio inverts with the swap.
      aspectRatio: s.aspectRatio > 0 ? 1 / s.aspectRatio : 1,
      // The PHYSICAL tag rotates 90° — hole + cuts move to the right
      // edge in horizontal mode, back to the top in vertical mode.
      tagOrientation:
        s.tagOrientation === "vertical" ? "horizontal" : "vertical",
    });

    // Relative re-centering: each object's CENTRE keeps its
    // proportional position inside the bleed (e.g. 40 % across,
    // 50 % down stays 40 % across, 50 % down after the swap). No
    // scaleX / scaleY mutation → no stretching. No `angle` mutation →
    // text stays upright. The mapping uses each object's own bounding
    // rect centre so groups, text and images all behave identically.
    if (canvas) {
      const VIRTUAL = 2000;
      const MM_PX = 10;
      const vcx = VIRTUAL / 2;
      const vcy = VIRTUAL / 2;
      const oldBleedW = oldLengthMm * MM_PX;
      const oldBleedH = oldWidthMm * MM_PX;
      const newBleedW = newLengthMm * MM_PX;
      const newBleedH = newWidthMm * MM_PX;
      const oldLeft = vcx - oldBleedW / 2;
      const oldTop = vcy - oldBleedH / 2;
      const newLeft = vcx - newBleedW / 2;
      const newTop = vcy - newBleedH / 2;

      const hist = history.isPaused();
      if (!hist) history.pause();

      canvas.getObjects().forEach((o: any) => {
        if (o.excludeFromExport) return;
        const br = o.getBoundingRect(true, true);
        const oldCx = br.left + br.width / 2;
        const oldCy = br.top + br.height / 2;
        // Relative position of object centre (0..1) inside the OLD bleed.
        // Clamp to [0,1] so objects sitting past the old edge map to the
        // nearest in-bounds position instead of overflowing the new bleed.
        const relX = clamp01((oldCx - oldLeft) / Math.max(1, oldBleedW));
        const relY = clamp01((oldCy - oldTop) / Math.max(1, oldBleedH));
        // Same relative position inside the NEW bleed.
        const newCx = newLeft + relX * newBleedW;
        const newCy = newTop + relY * newBleedH;
        // Translate by the centre delta (preserves scale + angle).
        const dx = newCx - oldCx;
        const dy = newCy - oldCy;
        if (dx !== 0 || dy !== 0) {
          o.left = (o.left ?? 0) + dx;
          o.top = (o.top ?? 0) + dy;
          o.setCoords();
        }
      });
      canvas.requestRenderAll();
      if (!hist) history.resume(false);
    }

    // Sync the inactive side's STORED snapshot to the new orientation so
    // it stays coherent when the user flips. Without this the inactive
    // snapshot keeps the OLD (length, width, tagOrientation) and re-loads
    // into the wrong-shape bleed, distorting every object.
    const inactiveKey =
      s.activeSide === "front" ? "backDesign" : "frontDesign";
    const inactiveSnap = (s as any)[inactiveKey] as SideSnapshot | null;
    if (inactiveSnap) {
      const rotatedSnap = rotateSnapshotOrientation(
        inactiveSnap,
        oldLengthMm,
        oldWidthMm,
        newLengthMm,
        newWidthMm
      );
      set({ [inactiveKey]: rotatedSnap } as any);
    }

    if (!history.isPaused()) {
      queueMicrotask(() => history.commit());
    }
  },

  productTitle: "Standard Visiting Cards",
  setProductTitle: (t) => set({ productTitle: t }),

  productSlug: null,
  setProductSlug: (s) => set({ productSlug: s }),

  productConfig: getProductConfig(null),
  setProductConfig: (c) => {
    const seeded = shapeFromProductConfig(c);
    // Clamp the seed against the new product's allowedShapes so we never
    // land in an illegal state (e.g. carrying "star" into woven labels).
    const next = c.allowedShapes.includes(seeded)
      ? seeded
      : c.allowedShapes[0] ?? "rectangle";
    set({
      productConfig: c,
      canvasShape: next as CanvasShape,
    });
  },

  customerId: null,
  setCustomerId: (id) => set({ customerId: id }),

  workId: null,
  setWorkId: (w) => set({ workId: w }),
  lastSavedAt: null,
  markSaved: () => set({ lastSavedAt: Date.now() }),

  mode: "blank",
  setMode: (m) => set({ mode: m }),

  templateId: null,
  templateName: null,
  templateImageUrl: null,
  templateJsonUrl: null,
  setTemplateMeta: (meta) =>
    set({
      templateId: meta.id,
      templateName: meta.name,
      templateImageUrl: meta.imageUrl,
      templateJsonUrl: meta.jsonUrl,
    }),
  setTemplateJsonUrl: (u) => set({ templateJsonUrl: u }),

  activeTool: null,
  setActiveTool: (t) =>
    set((s) => ({ activeTool: s.activeTool === t ? null : t })),
  openTool: (t) =>
    set((s) => (s.activeTool === t ? s : { activeTool: t })),

  zoom: 1,
  setZoom: (z) => set({ zoom: Math.min(Math.max(z, 0.1), 5) }),

  recentColors: [],
  addRecentColor: (c) => {
    if (!c || c === "transparent") return;
    set((s) => {
      const next = [c, ...s.recentColors.filter((k) => k !== c)].slice(0, 8);
      return { recentColors: next };
    });
  },

  showGuides: true,
  setShowGuides: (b) => {
    const canvas = get().canvas;
    set({ showGuides: b });
    if (canvas) {
      canvas.getObjects().forEach((o) => {
        const id = (o as any).id;
        if (id === "bleed" || id === "safety") {
          // Bleed always shows (it's the visible card). Hide just its
          // dashed stroke + safe area when guides are off.
          if (id === "safety") o.set("visible", b);
          if (id === "bleed") o.set("strokeWidth", b ? 2 : 0);
        }
      });
      canvas.requestRenderAll();
    }
  },

  isRecentDesignLoaded: false,
  setRecentDesignLoaded: (loaded) => set({ isRecentDesignLoaded: loaded }),
  originalUrlSearch: "",
  setOriginalUrlSearch: (s) => set({ originalUrlSearch: s }),

  uploadModalOpen: false,
  setUploadModalOpen: (b) => set({ uploadModalOpen: b }),

  _skipNextDimRescale: false,
  _setSkipNextDimRescale: (b) => set({ _skipNextDimRescale: b }),

  backgroundColor: "#ffffff",
  setBackgroundColor: (c) => {
    const canvas = get().canvas;
    const prev = get().backgroundColor;
    set({ backgroundColor: c });
    if (!canvas) return;
    // Always update the bleed rect so the colour is correct underneath
    // (it's what the user sees in non-template flows and through any
    // gaps in the template).
    const bleed = canvas.getObjects().find((o) => (o as any).id === "bleed");
    if (bleed) bleed.set("fill", c);
    // Templates ship their own full-bleed background rect, tagged on load
    // as `id: "templateBg"`. When present, that rect sits ON TOP of the
    // bleed and is what the user actually sees, so it has to receive the
    // colour change too.
    const tplBg = canvas
      .getObjects()
      .find((o) => (o as any).id === "templateBg");
    if (tplBg) {
      // Templates may use stroke instead of fill (rare but possible).
      // Always set fill — that's the visible field for a "background" rect.
      tplBg.set("fill", c);
    }
    canvas.requestRenderAll();
    // Bleed + templateBg are `excludeFromExport`, so fabric's events
    // won't trigger an undo snapshot for these mutations. Commit one
    // manually — but only on real changes (skip if the colour didn't
    // actually change, e.g. the picker fires an extra event on blur).
    if (prev !== c && !history.isPaused()) {
      history.commit();
    }
  },

  selected: null,
  updateActiveObject: (obj) => {
    if (!obj) {
      set({ selected: null });
      return;
    }

    const anyObj = obj as any;
    // Surface the OBJECT'S visible colour as `fill` in the store. For
    // lines, paths, and hollow shapes the stroke is what the eye sees,
    // so we read from stroke and write to stroke (see `patchActive`).
    // For groups (tables), peek at the first child's stroke so the
    // colour picker shows the right starting swatch.
    const target = colorTarget(anyObj);
    const strokeSource =
      anyObj.type === "group" && Array.isArray(anyObj._objects) && anyObj._objects[0]
        ? anyObj._objects[0].stroke
        : anyObj.stroke;
    const visibleColor =
      target === "stroke"
        ? safeString(strokeSource, DEFAULT_SELECTED.fill)
        : safeString(anyObj.fill, DEFAULT_SELECTED.fill);
    const next: SelectedItemState = {
      type: classifyType(obj),
      text: safeString(anyObj.text, ""),
      fontSize: safeNumber(anyObj.fontSize, DEFAULT_SELECTED.fontSize),
      fill: visibleColor,
      fontFamily: safeString(anyObj.fontFamily, DEFAULT_SELECTED.fontFamily),
      fontWeight: safeString(anyObj.fontWeight, DEFAULT_SELECTED.fontWeight),
      fontStyle: safeString(anyObj.fontStyle, DEFAULT_SELECTED.fontStyle),
      textAlign: safeString(anyObj.textAlign, DEFAULT_SELECTED.textAlign),
      opacity: safeNumber(anyObj.opacity, DEFAULT_SELECTED.opacity),
      angle: safeNumber(anyObj.angle, DEFAULT_SELECTED.angle),
      lineHeight: safeNumber(anyObj.lineHeight, DEFAULT_SELECTED.lineHeight),
      charSpacing: safeNumber(anyObj.charSpacing, DEFAULT_SELECTED.charSpacing),
      locked: !!(anyObj.lockMovementX && anyObj.lockMovementY),
      hasShadow: !!anyObj.shadow,
      strokeWidth: safeNumber(anyObj.strokeWidth, 0),
      underline: !!anyObj.underline,
      qrFgColor: safeString(anyObj.qrFgColor, DEFAULT_SELECTED.qrFgColor),
      qrBgColor: safeString(anyObj.qrBgColor, DEFAULT_SELECTED.qrBgColor),
      barColor: safeString(anyObj.barColor, DEFAULT_SELECTED.barColor),
      barBgColor: safeString(anyObj.barBgColor, DEFAULT_SELECTED.barBgColor),
      barHasBg:
        typeof anyObj.barHasBg === "boolean"
          ? anyObj.barHasBg
          : DEFAULT_SELECTED.barHasBg,
      // `isLowRes` / `isBlurry` are stamped onto the fabric object by
      // the workspace quality check; we surface them here so the toolbar
      // can light up the warning icon + Enhance affordance.
      isLowRes: !!anyObj.isLowRes,
      isBlurry: !!anyObj.isBlurry,
    };
    set({ selected: next });
  },

  /**
   * Regenerate the active QR image with new fg/bg colours. The QR was
   * baked to a PNG dataURL at create time; to recolour it we run the
   * QR encoder again with the same URL + new colours, then swap the
   * fabric.Image's source.
   *
   * `bgColor === "transparent"` produces a fully transparent background
   * so the bleed/template colour shows through behind the QR modules.
   */
  updateQrColors: async (fg?: string, bg?: string) => {
    const { canvas, selected } = get();
    if (!canvas || !selected || selected.type !== "qr") return;
    const obj = canvas.getActiveObject() as any;
    if (!obj || !obj.qrUrl) return;
    const fgColor = fg ?? obj.qrFgColor ?? "#000000";
    const bgColor = bg ?? obj.qrBgColor ?? "#ffffff";
    try {
      const QR = (await import("qrcode")).default;
      const dataUrl = await QR.toDataURL(obj.qrUrl, {
        width: 512,
        margin: 1,
        errorCorrectionLevel: "M",
        color: {
          dark: fgColor,
          // qrcode uses #RRGGBBAA — append "00" for full transparency.
          light: bgColor === "transparent" ? "#00000000" : bgColor,
        },
      });
      obj.qrFgColor = fgColor;
      obj.qrBgColor = bgColor;
      obj.setSrc(dataUrl, () => {
        canvas.requestRenderAll();
        canvas.fire("object:modified", { target: obj });
        const cur = get().selected;
        if (cur)
          set({ selected: { ...cur, qrFgColor: fgColor, qrBgColor: bgColor } });
      });
    } catch (e) {
      console.warn("[qr recolour] failed:", e);
    }
  },

  updateBarcodeColors: async ({ barColor, bgColor, hasBg }) => {
    const { canvas, selected } = get();
    if (!canvas || !selected || selected.type !== "barcode") return;
    const obj = canvas.getActiveObject() as any;
    if (!obj || !obj.barcodeText) return;
    const nextBar = barColor ?? obj.barColor ?? "#000000";
    const nextHasBg =
      typeof hasBg === "boolean" ? hasBg : obj.barHasBg !== false;
    const nextBg = bgColor ?? obj.barBgColor ?? "#ffffff";
    try {
      const url = buildBarcodeApiUrl(obj.barcodeText, {
        barColor: nextBar,
        bgColor: nextBg,
        hasBg: nextHasBg,
      });
      const resp = await fetch(url, { mode: "cors" });
      if (!resp.ok) throw new Error(`Barcode service ${resp.status}`);
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      obj.barColor = nextBar;
      obj.barBgColor = nextBg;
      obj.barHasBg = nextHasBg;
      obj.setSrc(
        objectUrl,
        () => {
          canvas.requestRenderAll();
          canvas.fire("object:modified", { target: obj });
          URL.revokeObjectURL(objectUrl);
          const cur = get().selected;
          if (cur)
            set({
              selected: {
                ...cur,
                barColor: nextBar,
                barBgColor: nextBg,
                barHasBg: nextHasBg,
              },
            });
        },
        { crossOrigin: "anonymous" }
      );
    } catch (e) {
      console.warn("[barcode recolour] failed:", e);
      get().setCanvasWarning("Couldn't update barcode colour — try again.");
    }
  },

  patchActive: (patch) => {
    const { canvas, selected } = get();
    if (!canvas || !selected) return;
    const active = canvas.getActiveObject();
    if (!active) return;

    // Push fabric mutations
    Object.entries(patch).forEach(([k, v]) => {
      if (v === undefined) return;
      if (k === "locked") {
        const locked = !!v;
        active.set({
          lockMovementX: locked,
          lockMovementY: locked,
          lockScalingX: locked,
          lockScalingY: locked,
          lockRotation: locked,
          hasControls: !locked,
        });
      } else if (k === "fill") {
        // Route colour changes to fill OR stroke depending on the object
        // (see `colorTarget` for the rules — lines / hollow shapes / open
        // paths are stroke-coloured). For groups (tables), fan out to
        // each child using its own routing so a single colour pick
        // recolours every line in the table.
        if (
          active.type === "group" &&
          Array.isArray((active as any)._objects)
        ) {
          (active as any)._objects.forEach((child: any) => {
            child.set(colorTarget(child) as any, v as any);
          });
          // Tell fabric the group needs a re-render — child mutations
          // don't always invalidate the cached group bitmap.
          (active as any).dirty = true;
        } else {
          active.set(colorTarget(active) as any, v as any);
        }
      } else if (k === "underline") {
        active.set("underline" as any, !!v);
      } else if (k === "strokeWidth") {
        // Editing border / divider thickness. If the user adds a stroke
        // to a solid shape with none, default the stroke colour to the
        // current fill so the border is visible immediately.
        const w = Number(v);
        if (Number.isFinite(w)) {
          active.set("strokeWidth" as any, w);
          active.set("strokeUniform" as any, true);
          if (w > 0) {
            const currentStroke = (active as any).stroke;
            if (!currentStroke || currentStroke === "transparent") {
              const currentFill = (active as any).fill;
              const fallback =
                typeof currentFill === "string" && currentFill !== "transparent"
                  ? currentFill
                  : "#0a1f44";
              active.set("stroke" as any, fallback);
            }
          }
        }
      } else if (k === "hasShadow") {
        // Fabric accepts a CSS-like shadow string and parses it internally.
        // Pass `null` to remove an existing shadow.
        active.set(
          "shadow" as any,
          v ? "rgba(0,0,0,0.35) 4px 6px 12px" : (null as any)
        );
      } else {
        active.set(k as any, v as any);
      }
    });
    active.setCoords();
    canvas.requestRenderAll();
    canvas.fire("object:modified", { target: active });

    set({ selected: { ...selected, ...patch } });
  },

  canUndo: false,
  canRedo: false,
  setHistoryFlags: (canUndo, canRedo) => set({ canUndo, canRedo }),

  // ---- canvas shape (dynamic Hangtag silhouette) ----
  canvasShape: shapeFromProductConfig(getProductConfig(null)),
  setCanvasShape: (s) => {
    const cur = get();
    if (cur.canvasShape === s) return;
    // Reject illegal shape for this product (e.g. star on woven labels).
    if (!cur.productConfig.allowedShapes.includes(s)) return;
    set({ canvasShape: s });
    // Snapshot the change so it lives in the undo stack alongside other
    // canvas mutations. Skip when history is paused (during bulk loads).
    if (!history.isPaused()) {
      // Defer one tick so React + the Workspace guide-redraw effect both
      // run before we lock in the snapshot.
      queueMicrotask(() => history.commit());
    }
  },
  shapeModifiers: DEFAULT_SHAPE_MODIFIERS,
  updateShapeModifiers: (patch) => {
    set((s) => ({
      shapeModifiers: { ...s.shapeModifiers, ...patch },
    }));
    if (!history.isPaused()) {
      queueMicrotask(() => history.commit());
    }
  },

  canvasWarning: null,
  canvasWarningId: 0,
  canvasWarningType: "warning",
  setCanvasWarning: (msg, type = "warning") => {
    if (msg) {
      // Bump the nonce so the toast re-mounts + replays its animation
      // even when the message text is identical to the one showing.
      set((s) => ({
        canvasWarning: msg,
        canvasWarningType: type,
        canvasWarningId: s.canvasWarningId + 1,
      }));
      if (warningHideTimer) clearTimeout(warningHideTimer);
      const myId = get().canvasWarningId;
      warningHideTimer = window.setTimeout(() => {
        // Clear ONLY if no newer warning has superseded this one. We
        // compare the nonce (not the string) so back-to-back identical
        // warnings each get their full 5s window. Per spec we always
        // reset the state to null when our window expires.
        if (get().canvasWarningId === myId) {
          set({ canvasWarning: null });
        }
        warningHideTimer = null;
      }, 5000);
    } else {
      if (warningHideTimer) {
        clearTimeout(warningHideTimer);
        warningHideTimer = null;
      }
      set({ canvasWarning: null });
    }
  },

  previewOpen: false,
  setPreviewOpen: (b) => set({ previewOpen: b }),

  isTourActive: false,
  setTourActive: (b) => set({ isTourActive: b }),

  // ---- 3D Flip Preview Modal ------------------------------------------
  previewFlipOpen: false,
  setPreviewFlipOpen: (b) => set({ previewFlipOpen: b }),

  // ---- Tag orientation (vertical = hole on top, horizontal = right) ---
  tagOrientation: "vertical",
  setTagOrientation: (o) => set({ tagOrientation: o }),

  // ---- Preview MODE (texture overlay on canvas) -----------------------
  previewMode: false,
  setPreviewMode: (b) => {
    const canvas = get().canvas;
    set({ previewMode: b });
    if (!canvas) return;
    // Lock all user objects + hide editing guides so the canvas reads
    // as a finished, untouchable preview.
    canvas.getObjects().forEach((o) => {
      const id = (o as any).id;
      const isGuide =
        id === "bleed" || id === "safety" || id === "holePunch";
      if (isGuide) {
        // Bleed stays visible (it IS the visible card), but we drop the
        // sky-blue stroke and dashed safe area while in preview.
        if (id === "bleed") {
          if (b) {
            // Save the original stroke width ONCE when entering preview.
            if ((o as any)._origStrokeWidth == null) {
              (o as any)._origStrokeWidth = (o as any).strokeWidth ?? 2;
            }
            o.set("strokeWidth", 0);
          } else {
            const orig = (o as any)._origStrokeWidth;
            o.set("strokeWidth", typeof orig === "number" ? orig : 2);
            (o as any)._origStrokeWidth = undefined;
          }
        } else {
          o.set("visible", !b);
        }
        return;
      }
      // Lock user objects so they can't be dragged / resized in preview.
      o.set({
        selectable: !b,
        evented: !b,
        hasControls: !b,
        hasBorders: !b,
      } as any);
    });
    if (b) canvas.discardActiveObject();
    canvas.requestRenderAll();
  },

  // ---- Front / Back state ---------------------------------------------
  activeSide: "front",
  frontDesign: null,
  backDesign: null,
  backChooserOpen: false,
  setBackChooserOpen: (b) => set({ backChooserOpen: b }),
  confirmDeleteBackOpen: false,
  setConfirmDeleteBackOpen: (b) => set({ confirmDeleteBackOpen: b }),
  nextBackCheckOpen: false,
  setNextBackCheckOpen: (b) => set({ nextBackCheckOpen: b }),
  setFrontDesign: (snap) => set({ frontDesign: snap }),
  setBackDesign: (snap) => set({ backDesign: snap }),
  loadDesign: async (row) => {
    // Wrap the entire restore in a try / catch so a single malformed
    // field never blocks the user from loading a design.
    try {
      if (!row) {
        console.error("[loadDesign] no row supplied");
        return;
      }

      // ----- Reconstruct the FRONT side --------------------------------
      const rawFront = row.fabric_json;
      if (!rawFront) {
        console.error("[loadDesign] row has no fabric_json — aborting");
        return;
      }
      const frontJsonObj = parseJsonLoose(rawFront);
      if (!frontJsonObj) {
        console.error("[loadDesign] front fabric_json is not parseable");
        return;
      }

      const meta = row.meta || {};
      const frontMeta = meta.frontSide || {};
      // Background colour priority (high → low):
      //   1) meta.frontSide.backgroundColor (per-side persisted)
      //   2) fabric_json.background (fabric's native top-level field)
      //   3) Bleed rect's fill, if the fabric JSON contains one
      //   4) "#ffffff"
      const frontBg =
        firstString(
          frontMeta.backgroundColor,
          frontJsonObj.background,
          bleedFillFromJson(frontJsonObj)
        ) ?? "#ffffff";
      const frontOrientation: "vertical" | "horizontal" =
        frontMeta.tagOrientation === "horizontal" ? "horizontal" : "vertical";
      const frontLen =
        toFiniteNumber(frontMeta.lengthMm) ??
        toFiniteNumber(row.length_mm) ??
        90;
      const frontWid =
        toFiniteNumber(frontMeta.widthMm) ??
        toFiniteNumber(row.width_mm) ??
        50;
      const frontSnap: SideSnapshot = {
        fabric: frontJsonObj,
        backgroundColor: frontBg,
        tagOrientation: frontOrientation,
        lengthMm: frontLen,
        widthMm: frontWid,
      };

      // ----- Reconstruct the BACK side, if any -------------------------
      // Prefer the dedicated column; fall back to the meta-mirrored copy
      // (used when the schema was missing the column at save time).
      const rawBack = row.fabric_json_back ?? meta.backFabricJson ?? null;
      let backSnap: SideSnapshot | null = null;
      if (rawBack) {
        const backJsonObj = parseJsonLoose(rawBack);
        if (backJsonObj) {
          const backMeta = meta.backSide || {};
          const backBg =
            firstString(
              backMeta.backgroundColor,
              backJsonObj.background,
              bleedFillFromJson(backJsonObj)
            ) ?? frontBg;
          // Honour the back's saved orientation even when it differs
          // from the front (front-landscape + back-portrait is valid).
          // Only fall back to the front's orientation when the back has
          // no orientation saved at all.
          const backOrientation: "vertical" | "horizontal" =
            backMeta.tagOrientation === "horizontal"
              ? "horizontal"
              : backMeta.tagOrientation === "vertical"
                ? "vertical"
                : frontOrientation;
          const backLen =
            toFiniteNumber(backMeta.lengthMm) ?? frontLen;
          const backWid =
            toFiniteNumber(backMeta.widthMm) ?? frontWid;
          backSnap = {
            fabric: backJsonObj,
            backgroundColor: backBg,
            tagOrientation: backOrientation,
            lengthMm: backLen,
            widthMm: backWid,
          };
        } else {
          console.warn(
            "[loadDesign] back JSON failed to parse — back side will be empty"
          );
        }
      }

      // ----- Restore optional shape state ------------------------------
      const restoredCanvasShape =
        typeof meta.canvasShape === "string" ? meta.canvasShape : null;
      const restoredShapeModifiers =
        meta.shapeModifiers && typeof meta.shapeModifiers === "object"
          ? meta.shapeModifiers
          : null;

      // ----- Apply atomically to the store -----------------------------
      // One set() so the dim-change effect in Workspace observes a
      // CONSISTENT target state on its first re-render.
      set((s) => ({
        activeSide: "front",
        frontDesign: frontSnap,
        backDesign: backSnap,
        tagOrientation: frontOrientation,
        backgroundColor: frontBg,
        canvasLengthMm: frontLen,
        canvasWidthMm: frontWid,
        aspectRatio: frontLen / Math.max(1, frontWid),
        _skipNextDimRescale: true,
        canvasShape:
          (restoredCanvasShape as CanvasShape | null) ?? s.canvasShape,
        shapeModifiers: restoredShapeModifiers
          ? { ...s.shapeModifiers, ...restoredShapeModifiers }
          : s.shapeModifiers,
      }));

      // ----- Apply to canvas via designOps ----------------------------
      // Inject the saved background into the JSON's top-level `background`
      // field so designOps.loadJson restores it correctly (matching the
      // pattern setActiveSide uses).
      const fabricPayload = { ...frontJsonObj, background: frontBg };
      const { designOps } = await import("@/components/Workspace");
      await designOps.loadJson(fabricPayload, frontLen, frontWid);

      // After loadJson resolves, force a fresh guide redraw using the
      // CURRENT store state. This bypasses React effect batching: even
      // if the dim-effect skipped a re-run (because the dep value didn't
      // change between commits), redrawGuides reads tagOrientation +
      // dims + bg directly from `useCanvasStore.getState()` and rebuilds
      // bleed / safety / holePunch / clips in one synchronous pass.
      designOps.redrawGuides?.();
    } catch (e) {
      console.error("[loadDesign] failed:", e);
    }
  },
  initBackDesign: (kind) => {
    const s = get();
    if (s.activeSide === "back") {
      set({ backChooserOpen: false });
      return;
    }
    // Any real choice below (duplicate / blank / upload) adds a back side.
    // Surface a green, price-transparent confirmation toast.
    get().setCanvasWarning(
      "Back side added. Price will be calculated accordingly.",
      "success"
    );
    if (kind === "duplicate") {
      // Snapshot the LIVE canvas (fabric + paint + orientation + dims).
      // Mirror it to the back so the user starts with an exact copy.
      const snap = snapshotCanvas(s.canvas, s);
      if (snap) {
        set({
          frontDesign: snap,
          backDesign: snap,
          backChooserOpen: false,
        });
      } else {
        set({ backChooserOpen: false });
      }
      get().setActiveSide("back");
      return;
    }
    if (kind === "upload") {
      // Start blank + pop the uploads modal so the user can drop a file.
      set({ backChooserOpen: false, uploadModalOpen: true });
      get().setActiveSide("back");
      return;
    }
    // "blank" — straightforward switch with no preloaded JSON.
    set({ backChooserOpen: false });
    get().setActiveSide("back");
  },
  setActiveSide: (side) => {
    const s = get();
    if (s.activeSide === side) return;
    const canvas = s.canvas;
    if (!canvas) {
      set({ activeSide: side });
      return;
    }
    // 1) Snapshot the CURRENT side — full state bundle (fabric JSON +
    //    paint + orientation + dimensions). Stored verbatim so a later
    //    switch faithfully restores every visual fact about this side.
    const snap = snapshotCanvas(canvas, s);
    const prevSide = s.activeSide;
    if (snap) {
      set({
        [prevSide === "front" ? "frontDesign" : "backDesign"]: snap,
        activeSide: side,
      } as any);
    } else {
      set({ activeSide: side });
    }

    // 2) DEFER the target JSON load. The Workspace half-flip orchestration
    //    invokes `loadActiveSideJson()` at the 90° midpoint — the exact
    //    moment the canvas is edge-on (invisible) — so the content swap
    //    is never visible to the user. If the canvas hasn't been mounted
    //    by the orchestration (e.g. supportsBackSide is false elsewhere
    //    in a future product), the swap still completes at the next
    //    microtask so single-side products don't regress.
    if (!productSupportsHalfFlip(get())) {
      queueMicrotask(() => get().loadActiveSideJson());
    }
  },
  loadActiveSideJson: () => {
    const s = get();
    const targetSnap =
      s.activeSide === "front" ? s.frontDesign : s.backDesign;
    import("@/components/Workspace").then(({ designOps }) => {
      if (targetSnap) {
        try {
          const targetLen = targetSnap.lengthMm || get().canvasLengthMm;
          const targetWid = targetSnap.widthMm || get().canvasWidthMm;
          set({
            tagOrientation: targetSnap.tagOrientation,
            canvasLengthMm: targetLen,
            canvasWidthMm: targetWid,
            aspectRatio: targetLen / Math.max(1, targetWid),
            _skipNextDimRescale: true,
          });
          const fabricPayload =
            typeof targetSnap.fabric === "string"
              ? JSON.parse(targetSnap.fabric)
              : { ...(targetSnap.fabric || {}) };
          fabricPayload.background = targetSnap.backgroundColor;
          // Side snapshots are ALREADY sized for the current bleed — skip
          // the fit-to-bleed rescale so objects (incl. fabric.Path signs)
          // never shift / inflate across Front↔Back switches.
          designOps.loadJson(fabricPayload, targetLen, targetWid, {
            skipFit: true,
          });
        } catch (e) {
          console.warn("[loadActiveSideJson] failed to load target:", e);
          designOps.clearAll();
        }
      } else {
        designOps.clearAll();
      }
    });
  },
  clearBackDesign: () => {
    const s = get();
    // If the user is currently editing the back side, hop back to front
    // FIRST so setActiveSide can persist their in-progress back work into
    // a snapshot we are about to throw away — and so the canvas gets
    // repainted with the front design before we null out backDesign.
    if (s.activeSide === "back") {
      // Don't preserve the back snapshot — we're discarding it. Skip the
      // setActiveSide path (which would snapshot the canvas into
      // backDesign) and instead manually load the front snapshot.
      const canvas = s.canvas;
      const frontSnap = s.frontDesign;
      set({ activeSide: "front", backDesign: null });
      if (canvas && frontSnap) {
        import("@/components/Workspace").then(({ designOps }) => {
          try {
            const len = frontSnap.lengthMm || s.canvasLengthMm;
            const wid = frontSnap.widthMm || s.canvasWidthMm;
            set({
              tagOrientation: frontSnap.tagOrientation,
              canvasLengthMm: len,
              canvasWidthMm: wid,
              aspectRatio: len / Math.max(1, wid),
              _skipNextDimRescale: true,
            });
            const fabricPayload =
              typeof frontSnap.fabric === "string"
                ? JSON.parse(frontSnap.fabric)
                : { ...(frontSnap.fabric || {}) };
            fabricPayload.background = frontSnap.backgroundColor;
            // Front snapshot is already sized for the bleed — skip fit.
            designOps.loadJson(fabricPayload, len, wid, { skipFit: true });
          } catch (e) {
            console.warn("[clearBackDesign] failed to restore front:", e);
          }
        });
      }
      return;
    }
    // Already on front — just discard the back slot.
    set({ backDesign: null });
  },
}));

/**
 * Capture a SideSnapshot from the live fabric canvas + current paint /
 * orientation / dimensions. Returns `null` if the canvas is missing.
 */
function snapshotCanvas(
  canvas: fabric.Canvas | null,
  storeState: CanvasStoreState
): SideSnapshot | null {
  if (!canvas) return null;
  const propsToInclude = [
    "id",
    "qrUrl",
    "qrFgColor",
    "qrBgColor",
    "barcodeText",
    "barColor",
    "barBgColor",
    "barHasBg",
    "excludeFromExport",
    "selectable",
    "evented",
  ];
  return {
    fabric: canvas.toJSON(propsToInclude),
    backgroundColor: storeState.backgroundColor,
    tagOrientation: storeState.tagOrientation,
    lengthMm: storeState.canvasLengthMm,
    widthMm: storeState.canvasWidthMm,
  };
}

export const DEFAULT_SELECTED_STATE = DEFAULT_SELECTED;
