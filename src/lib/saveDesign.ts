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
      input.backgroundColor
    );
  } catch (e) {
    console.warn("[saveDesign] live snapshot failed:", e);
  }

  // 2. If the product is two-sided AND the OTHER side has actual stored
  //    content, render it offscreen so the final payload always carries
  //    both faces. `snapshotFromStoredSnapshot` is now null-safe and
  //    timeout-safe — it resolves to null on any problem rather than
  //    hanging the save flow.
  const otherStored =
    input.activeSide === "front" ? input.backDesign : input.frontDesign;
  const otherSide = input.supportsBackSide
    ? await snapshotFromStoredSnapshot(otherStored)
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

function snapshotLive(
  canvas: fabric.Canvas,
  lengthMm: number,
  widthMm: number,
  tagOrientation: "vertical" | "horizontal",
  backgroundColor: string
): SidePayload {
  const safety = canvas.getObjects().find((o) => (o as any).id === "safety");
  const bleed = canvas.getObjects().find((o) => (o as any).id === "bleed");
  // Hide the hole punch guide too — it's a STUDIO editing overlay
  // (dashed red ring) that must NOT bleed into the saved PNG that
  // ships to the Shopify finalize page.
  const hole = canvas.getObjects().find((o) => (o as any).id === "holePunch");
  const prevSafetyOpacity = safety?.opacity ?? 1;
  const prevBleedStroke = (bleed as any)?.stroke;
  const prevBleedStrokeWidth = (bleed as any)?.strokeWidth;
  const prevHoleOpacity = hole?.opacity ?? 1;
  if (safety) safety.set("opacity", 0);
  if (bleed) bleed.set({ stroke: "transparent", strokeWidth: 0 });
  if (hole) hole.set("opacity", 0);
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
  if (hole) hole.set("opacity", prevHoleOpacity);
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
  snap: SideSnapshot | null | undefined
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
          off!.getObjects().forEach((o: any) => {
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
