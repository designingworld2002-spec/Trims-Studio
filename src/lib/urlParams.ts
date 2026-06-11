/**
 * Read product/template configuration from the current URL.
 *
 * Dimension naming:
 *   `length` — long (X-axis) dimension in mm
 *   `width`  — short (Y-axis) dimension in mm
 *
 * Legacy URLs that used `width`/`height` are still accepted: if the URL
 * carries an explicit `height` param we treat the older `width` as the
 * length so existing Shopify links keep working.
 *
 * Supported modes (driven by the `mode` query param):
 *
 *  - `mode=template`: open the editor with a template pre-loaded.
 *      Required: length, width, template_json
 *      Optional: template_id, template_name, template_image, product, product_title
 *
 *  - `mode=upload`: open the editor with the Uploads side panel auto-opened
 *      so the user can immediately upload their own design.
 *      Required: length, width
 *      Optional: autoOpenUpload (default true when mode=upload), product, product_title
 *
 *  - (no mode): blank canvas with default sizing — useful for local dev.
 *
 * Example URLs:
 *  /?mode=template&length=120&width=70&template_id=4&template_image=...&template_json=...&product=woven-labels&product_title=Woven+Labels
 *  /?mode=upload&length=70&width=55&product=woven-labels&product_title=Woven+Labels&autoOpenUpload=true
 */

export type StudioMode = "template" | "upload" | "blank";

export interface UrlConfig {
  mode: StudioMode;
  lengthMm: number;
  widthMm: number;

  /** Display title (top bar). Falls back to product slug or a generic label. */
  title: string;
  /** Stable product slug (`woven-labels`, `visiting-cards`, …). */
  productSlug: string | null;

  /** Template metadata (only meaningful when mode === "template"). */
  templateId: string | null;
  templateName: string | null;
  templateImageUrl: string | null;
  templateJsonUrl: string | null;

  /** Auto-open the Uploads panel on mount. */
  autoOpenUpload: boolean;

  /** Existing auto-save id to resume — populated after first edit. */
  workId: string | null;

  /** Shopify customer.id when the storefront passes it. */
  customerId: string | null;
}

function parseBool(v: string | null): boolean {
  if (v == null) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function parseMode(raw: string | null): StudioMode {
  if (raw === "template" || raw === "upload") return raw;
  return "blank";
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readUrlConfig(
  defaultDimensions: { lengthMm: number; widthMm: number } = {
    lengthMm: 90,
    widthMm: 50,
  }
): UrlConfig {
  const params = new URLSearchParams(window.location.search);

  const mode = parseMode(params.get("mode"));

  // Dimension parsing with legacy-URL fallback.
  // If the URL has `height=` we treat it as the legacy schema where `width`
  // meant the long dimension. Otherwise the canonical naming wins:
  // `length` = long, `width` = short.
  // When the URL omits dimensions entirely we fall back to the active
  // product's `defaultDimensions` (passed in by main.tsx) rather than a
  // hard-coded woven-label size.
  const usingLegacy = !params.has("length") && params.has("height");
  const lengthMm = parsePositiveInt(
    usingLegacy ? params.get("width") : params.get("length"),
    defaultDimensions.lengthMm
  );
  const widthMm = parsePositiveInt(
    usingLegacy ? params.get("height") : params.get("width"),
    defaultDimensions.widthMm
  );

  const productSlug = params.get("product");
  const productTitle = params.get("product_title") ?? params.get("title");

  const title =
    productTitle?.trim() ||
    (productSlug
      ? productSlug
          .split(/[-_]/)
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join(" ")
      : "Custom Design");

  // URLSearchParams already decodes %3A %2F etc., so these come out as full URLs.
  const templateJsonUrl = params.get("template_json");
  const templateImageUrl = params.get("template_image");

  // autoOpenUpload defaults to true when mode=upload (so a missing param still
  // produces the expected behaviour), but is honored explicitly otherwise.
  const explicitAutoOpen = params.has("autoOpenUpload");
  const autoOpenUpload = explicitAutoOpen
    ? parseBool(params.get("autoOpenUpload"))
    : mode === "upload";

  return {
    mode,
    lengthMm,
    widthMm,
    title,
    productSlug,
    templateId: params.get("template_id"),
    templateName: params.get("template_name"),
    templateImageUrl,
    templateJsonUrl: mode === "template" ? templateJsonUrl : null,
    autoOpenUpload,
    workId: params.get("workId"),
    customerId:
      params.get("customer_id") ??
      params.get("customerId") ??
      params.get("shopify_customer_id"),
  };
}
