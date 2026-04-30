import { create } from "zustand";
import type { fabric } from "fabric";
import type { StudioMode } from "@/lib/urlParams";

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

  /** Product display title (from URL `product_title=` or fallback). */
  productTitle: string;
  setProductTitle: (t: string) => void;

  /** Stable product slug from `product=` (e.g. `woven-labels`). */
  productSlug: string | null;
  setProductSlug: (s: string | null) => void;

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
  setActiveTool: (t: ToolKey) => void;

  zoom: number; // 1 = fit
  setZoom: (z: number) => void;

  /** Background color of the trim card. */
  backgroundColor: string;
  setBackgroundColor: (c: string) => void;

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

  // ---- history (Undo/Redo) ----
  canUndo: boolean;
  canRedo: boolean;
  setHistoryFlags: (canUndo: boolean, canRedo: boolean) => void;

  // ---- preview ----
  previewOpen: boolean;
  setPreviewOpen: (b: boolean) => void;
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
  if (t === "image") return "image";
  if (t === "rect" || t === "circle" || t === "triangle" || t === "polygon" || t === "path")
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

  productTitle: "Standard Visiting Cards",
  setProductTitle: (t) => set({ productTitle: t }),

  productSlug: null,
  setProductSlug: (s) => set({ productSlug: s }),

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

  zoom: 1,
  setZoom: (z) => set({ zoom: Math.min(Math.max(z, 0.1), 5) }),

  backgroundColor: "#ffffff",
  setBackgroundColor: (c) => {
    const canvas = get().canvas;
    set({ backgroundColor: c });
    // The Bleed rectangle is the visible "card" in the new model — its
    // fill is what the user sees as the background colour. The outer
    // workspace stays a fixed light gray (handled by CSS, not fabric).
    if (canvas) {
      const bleed = canvas.getObjects().find((o) => (o as any).id === "bleed");
      if (bleed) {
        bleed.set("fill", c);
        canvas.requestRenderAll();
      }
    }
  },

  selected: null,
  updateActiveObject: (obj) => {
    if (!obj) {
      set({ selected: null });
      return;
    }

    const anyObj = obj as any;
    // For "hollow" shapes (transparent fill + stroke) the visible colour
    // is the stroke. Surface that as `fill` in the store so the colour
    // picker shows the right swatch and the user can edit it through the
    // same control as solid shapes.
    const hollow = isHollowShape(anyObj);
    const visibleColor = hollow
      ? safeString(anyObj.stroke, DEFAULT_SELECTED.fill)
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
    };
    set({ selected: next });
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
      } else if (k === "fill" && isHollowShape(active)) {
        // Route colour changes for hollow (outline) shapes to `stroke`.
        active.set("stroke" as any, v as any);
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

  previewOpen: false,
  setPreviewOpen: (b) => set({ previewOpen: b }),
}));

export const DEFAULT_SELECTED_STATE = DEFAULT_SELECTED;
