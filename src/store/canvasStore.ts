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
  | "qr"
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
  // QR images are tagged with `qrUrl` at creation time so we can route
  // their colour pickers through the regenerator instead of the generic
  // fill/stroke path.
  if (t === "image" && (obj as any).qrUrl) return "qr";
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

  backgroundColor: "#ffffff",
  setBackgroundColor: (c) => {
    const canvas = get().canvas;
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

  previewOpen: false,
  setPreviewOpen: (b) => set({ previewOpen: b }),
}));

export const DEFAULT_SELECTED_STATE = DEFAULT_SELECTED;
