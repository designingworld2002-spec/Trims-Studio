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
}

const MM_TO_PX = 10;
const VIRTUAL_SIZE = 2000;
const PREVIEW_MULTIPLIER = 2; // 2× = ~600 dpi for a 70mm label

export async function saveDesign(
  input: SaveDesignInput
): Promise<SaveDesignResult> {
  const { canvas } = input;

  // 1. Capture LIVE canvas → PNG + JSON for the active side.
  const live = snapshotLive(canvas, input.lengthMm, input.widthMm);

  // 2. If the product is two-sided and the OTHER side has stored work,
  //    render it offscreen so the final payload always includes BOTH
  //    sides — never silently drop the back design.
  const otherStored =
    input.activeSide === "front" ? input.backDesign : input.frontDesign;
  let otherSide: SidePayload | null = null;
  if (input.supportsBackSide && otherStored) {
    try {
      otherSide = await snapshotFromStoredSnapshot(otherStored);
    } catch (e) {
      console.warn("[saveDesign] failed to render stored side, skipping:", e);
    }
  }

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
    return await saveToSupabase(frontSide, backSide, input);
  } catch (e) {
    console.warn(
      "[trims-studio] Supabase save failed, falling back to localStorage:",
      e
    );
    return saveLocally(frontSide, backSide, input);
  }
}

/* ------------------------------------------------------------------ */
/* Side snapshot helpers                                                */
/* ------------------------------------------------------------------ */

function snapshotLive(
  canvas: fabric.Canvas,
  lengthMm: number,
  widthMm: number
): SidePayload {
  const safety = canvas.getObjects().find((o) => (o as any).id === "safety");
  const bleed = canvas.getObjects().find((o) => (o as any).id === "bleed");
  const prevSafetyOpacity = safety?.opacity ?? 1;
  const prevBleedStroke = (bleed as any)?.stroke;
  const prevBleedStrokeWidth = (bleed as any)?.strokeWidth;
  if (safety) safety.set("opacity", 0);
  if (bleed) bleed.set({ stroke: "transparent", strokeWidth: 0 });
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

  if (safety) safety.set("opacity", prevSafetyOpacity);
  if (bleed)
    bleed.set({
      stroke: prevBleedStroke as any,
      strokeWidth: prevBleedStrokeWidth as any,
    });
  canvas.renderAll();

  const fabricJson = canvas.toJSON([
    "id",
    "selectable",
    "evented",
    "excludeFromExport",
    "qrUrl",
    "qrFgColor",
    "qrBgColor",
  ]);

  return {
    previewDataUrl,
    fabricJson,
    lengthMm,
    widthMm,
  };
}

/**
 * Render a SideSnapshot (stored in the Zustand store) onto an off-screen
 * fabric.StaticCanvas and export the PNG. Used to capture the side the
 * user ISN'T currently editing, so the final payload always carries
 * both faces.
 */
function snapshotFromStoredSnapshot(
  snap: SideSnapshot
): Promise<SidePayload> {
  return new Promise((resolve, reject) => {
    const off = new fabric.StaticCanvas(null as any, {
      width: VIRTUAL_SIZE,
      height: VIRTUAL_SIZE,
    });
    try {
      const payload =
        typeof snap.fabric === "string"
          ? JSON.parse(snap.fabric)
          : { ...(snap.fabric || {}) };
      // Force the saved background colour to render via the bleed rect.
      payload.background = snap.backgroundColor;
      off.loadFromJSON(payload, () => {
        off.getObjects().forEach((o: any) => {
          if (o.id === "safety" || o.id === "holePunch") {
            o.set("visible", false);
          }
          if (o.id === "bleed") {
            o.set({
              stroke: "transparent",
              strokeWidth: 0,
              fill: snap.backgroundColor,
            });
          }
        });
        off.renderAll();
        const trimW = snap.lengthMm * MM_TO_PX;
        const trimH = snap.widthMm * MM_TO_PX;
        const cx = VIRTUAL_SIZE / 2;
        const cy = VIRTUAL_SIZE / 2;
        const previewDataUrl = off.toDataURL({
          format: "png",
          left: cx - trimW / 2,
          top: cy - trimH / 2,
          width: trimW,
          height: trimH,
          multiplier: PREVIEW_MULTIPLIER,
        });
        off.dispose();
        resolve({
          previewDataUrl,
          fabricJson: payload,
          lengthMm: snap.lengthMm,
          widthMm: snap.widthMm,
        });
      });
    } catch (e) {
      off.dispose();
      reject(e);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Supabase implementation                                              */
/* ------------------------------------------------------------------ */

async function saveToSupabase(
  frontSide: SidePayload | null,
  backSide: SidePayload | null,
  input: SaveDesignInput
): Promise<SaveDesignResult> {
  const supabase = getSupabase()!;
  const designId = crypto.randomUUID();
  const folder = input.customerId ?? "anon";

  // Helper — upload one side's PNG and return its public URL + path.
  const uploadSide = async (
    side: SidePayload,
    suffix: "front" | "back"
  ): Promise<{ url: string; path: string }> => {
    const path = `${folder}/${designId}-${suffix}.png`;
    const { error: uploadErr } = await supabase.storage
      .from(SUPABASE_DESIGNS_BUCKET)
      .upload(path, dataUrlToBlob(side.previewDataUrl), {
        contentType: "image/png",
        upsert: false,
      });
    if (uploadErr)
      throw new Error(`storage upload (${suffix}): ${uploadErr.message}`);
    const { data: pub } = supabase.storage
      .from(SUPABASE_DESIGNS_BUCKET)
      .getPublicUrl(path);
    const url = pub?.publicUrl ?? null;
    if (!url) {
      throw new Error(
        `storage getPublicUrl returned no URL for ${suffix} — check bucket "${SUPABASE_DESIGNS_BUCKET}"`
      );
    }
    return { url, path };
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

  // Row insert. `preview_url` keeps backwards compatibility for any
  // storefront code still reading the legacy single-PNG field.
  const { error: insertErr } = await supabase.from("user_designs").insert({
    id: designId,
    customer_id: input.customerId,
    product_slug: input.productSlug,
    product_title: input.productTitle,
    length_mm: input.lengthMm,
    width_mm: input.widthMm,
    fabric_json: frontSide?.fabricJson ?? null,
    fabric_json_back: backSide?.fabricJson ?? null,
    preview_url: frontUrl,
    preview_url_back: backUrl,
    preview_path: frontPath,
    preview_path_back: backPath,
    work_id: input.workId,
    source_template_id: input.templateId,
    meta: {
      ua: navigator.userAgent,
      savedAt: new Date().toISOString(),
      canvasShape: input.canvasShape,
      shapeModifiers: input.shapeModifiers,
      supportsBackSide: input.supportsBackSide,
      activeSide: input.activeSide,
    },
  });
  if (insertErr) throw new Error(`insert row: ${insertErr.message}`);

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
