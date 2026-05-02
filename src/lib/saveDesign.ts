import type { fabric } from "fabric";
import {
  getSupabase,
  isSupabaseConfigured,
  SUPABASE_DESIGNS_BUCKET,
  SHOPIFY_FINALIZE_URL,
} from "./supabase";

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
}

export interface SaveDesignResult {
  designId: string;
  previewUrl: string | null;
  finalizeUrl: string;
  storedRemotely: boolean;
}

const MM_TO_PX = 10;
const VIRTUAL_SIZE = 2000;
const PREVIEW_MULTIPLIER = 2; // 2× = ~600 dpi for a 70mm label

export async function saveDesign(
  input: SaveDesignInput
): Promise<SaveDesignResult> {
  const { canvas } = input;

  // 1. Render preview. The bleed rect IS the visible card (it carries the
  // user's background colour), so we keep it during the snapshot. We only
  // hide the dashed safety guide and temporarily strip the bleed's own
  // dashed yellow stroke so the export looks like the printed card.
  const safety = canvas
    .getObjects()
    .find((o) => (o as any).id === "safety");
  const bleed = canvas
    .getObjects()
    .find((o) => (o as any).id === "bleed");
  const prevSafetyOpacity = safety?.opacity ?? 1;
  const prevBleedStroke = bleed?.stroke;
  const prevBleedStrokeWidth = bleed?.strokeWidth;
  if (safety) safety.set("opacity", 0);
  if (bleed) bleed.set({ stroke: "transparent", strokeWidth: 0 });
  canvas.renderAll();

  const trimW = input.lengthMm * MM_TO_PX;
  const trimH = input.widthMm * MM_TO_PX;
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

  // 2/3. Push to Supabase if configured, otherwise stash locally so dev
  // mode still produces a Continue → finalize redirect.
  if (!isSupabaseConfigured()) {
    return saveLocally(previewDataUrl, fabricJson, input);
  }
  try {
    return await saveToSupabase(previewDataUrl, fabricJson, input);
  } catch (e) {
    console.warn(
      "[trims-studio] Supabase save failed, falling back to localStorage:",
      e
    );
    return saveLocally(previewDataUrl, fabricJson, input);
  }
}

/* ------------------------------------------------------------------ */
/* Supabase implementation                                              */
/* ------------------------------------------------------------------ */

async function saveToSupabase(
  previewDataUrl: string,
  fabricJson: any,
  input: SaveDesignInput
): Promise<SaveDesignResult> {
  const supabase = getSupabase()!;
  const designId = crypto.randomUUID();

  // 1) Convert dataURL → Blob and upload to storage.
  const previewBlob = dataUrlToBlob(previewDataUrl);
  const folder = input.customerId ?? "anon";
  const previewPath = `${folder}/${designId}.png`;

  const { error: uploadErr } = await supabase.storage
    .from(SUPABASE_DESIGNS_BUCKET)
    .upload(previewPath, previewBlob, {
      contentType: "image/png",
      upsert: false,
    });
  if (uploadErr) throw new Error(`storage upload: ${uploadErr.message}`);

  const { data: pub } = supabase.storage
    .from(SUPABASE_DESIGNS_BUCKET)
    .getPublicUrl(previewPath);
  const previewUrl = pub?.publicUrl ?? null;

  // 2) Insert the row.
  const { error: insertErr } = await supabase.from("user_designs").insert({
    id: designId,
    customer_id: input.customerId,
    product_slug: input.productSlug,
    product_title: input.productTitle,
    length_mm: input.lengthMm,
    width_mm: input.widthMm,
    fabric_json: fabricJson,
    preview_url: previewUrl,
    preview_path: previewPath,
    work_id: input.workId,
    source_template_id: input.templateId,
    meta: {
      ua: navigator.userAgent,
      savedAt: new Date().toISOString(),
    },
  });
  if (insertErr) throw new Error(`insert row: ${insertErr.message}`);

  return {
    designId,
    previewUrl,
    finalizeUrl: buildFinalizeUrl({
      designId,
      previewUrl,
      input,
    }),
    storedRemotely: true,
  };
}

/* ------------------------------------------------------------------ */
/* Local fallback                                                       */
/* ------------------------------------------------------------------ */

function saveLocally(
  previewDataUrl: string,
  fabricJson: any,
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
    fabric_json: fabricJson,
    preview_url: previewDataUrl, // local: keep the dataURL inline
    preview_path: null,
    work_id: input.workId,
    source_template_id: input.templateId,
    saved_at: new Date().toISOString(),
  };
  try {
    localStorage.setItem(`trims:final:${designId}`, JSON.stringify(record));
  } catch (e) {
    console.warn("[trims-studio] localStorage write failed:", e);
  }
  return {
    designId,
    previewUrl: previewDataUrl,
    finalizeUrl: buildFinalizeUrl({
      designId,
      previewUrl: null,
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
  input: SaveDesignInput;
}): string {
  const u = new URL(SHOPIFY_FINALIZE_URL);
  u.searchParams.set("design_id", opts.designId);
  if (opts.previewUrl && opts.previewUrl.startsWith("http")) {
    u.searchParams.set("preview_url", opts.previewUrl);
  }
  if (opts.input.productSlug)
    u.searchParams.set("product", opts.input.productSlug);
  u.searchParams.set("length", String(opts.input.lengthMm));
  u.searchParams.set("width", String(opts.input.widthMm));
  if (opts.input.customerId)
    u.searchParams.set("customer_id", opts.input.customerId);
  return u.toString();
}
