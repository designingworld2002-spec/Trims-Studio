/**
 * Shared pricing engine — the single source of truth the Studio uses to show
 * live prices (TopBar + Material setup modal).
 *
 * This MIRRORS the math in `product-finalization.liquid`'s `calculateTotal()`
 * so the price the user sees while designing matches the one they're quoted at
 * checkout. Keep the two in sync.
 *
 *   per-label base = ((lengthMm × widthMm) / 645) × <material rate for qty>
 *   Woven additionally carries its historic +30% markup.
 *   total          = per-label × qty
 *   quality        = High ×1.25 · Premium ×1.60  (Satin's Premium is ×2)
 *   back panel     = ×1.5 (two-sided design), applied last
 *
 * NOTE: Style add-ons (Fold / Laser Cut / Heat Cut) are deliberately NOT
 * included — the Studio has no Style picker; those are chosen on the finalize
 * page. So this is the *base* quote, and the finalize total may be higher.
 */

export type Material = "Woven" | "Cotton" | "Satin" | "Taffeta";
export type Quality = "Basic" | "High" | "Premium";

export const MATERIALS: Material[] = ["Woven", "Cotton", "Satin", "Taffeta"];

/** Human-facing labels used by the Material picker. */
export const MATERIAL_LABELS: Record<Material, string> = {
  Woven: "Woven",
  Cotton: "Cotton Printed",
  Satin: "Satin Printed",
  Taffeta: "Taffeta Printed",
};

/**
 * Try to read a Material out of one string. Returns `null` when the string
 * carries no material hint — callers can then fall through to the next
 * source (product handle, title, …) instead of wrongly locking in Woven.
 */
export function materialFromString(
  raw: string | null | undefined
): Material | null {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("cotton")) return "Cotton";
  if (s.includes("satin")) return "Satin";
  if (s.includes("taffeta")) return "Taffeta";
  if (s.includes("woven")) return "Woven";
  return null;
}

/**
 * Coerce a chain of hints (URL param, product handle, title, …) into a
 * canonical Material — FIRST source with a recognisable hint wins, so a
 * missing/malformed param falls through to the product handle instead of
 * silently defaulting to Woven. Defaults to Woven only when NO source
 * matches.
 */
export function normaliseMaterial(
  ...sources: (string | null | undefined)[]
): Material {
  for (const src of sources) {
    const m = materialFromString(src);
    if (m) return m;
  }
  return "Woven";
}

/**
 * Per-label rate for a material at a given total quantity. These tiers mirror
 * the Liquid engine exactly.
 */
function materialRate(material: Material, qty: number): number {
  switch (material) {
    case "Cotton":
      if (qty <= 1000) return 0.6;
      if (qty <= 2000) return 0.45;
      return 0.3;
    case "Satin":
      if (qty <= 1000) return 0.2;
      if (qty <= 2000) return 0.15;
      return 0.1;
    case "Taffeta":
      if (qty <= 1000) return 0.15;
      if (qty <= 2000) return 0.12;
      return 0.08;
    case "Woven":
    default:
      if (qty <= 1000) return 0.3;
      if (qty <= 2000) return 0.27;
      if (qty <= 3000) return 0.22;
      return 0.15;
  }
}

/**
 * Per-tag rate for a HANGTAG at a given total quantity. Tiered by qty:
 *   ≥8000 → 0.30 · 6000–7999 → 0.35 · 3000–5999 → 0.55 · <3000 → 0.70
 * The finishing add-ons (Thickness/Coating/UV/Thread) are already baked into
 * this universal rate, so they add no extra cost. Below the 1000 MOQ we still
 * return the lowest tier so a quote never breaks; ordering is gated elsewhere.
 */
function hangtagRate(qty: number): number {
  if (qty >= 8000) return 0.3;
  if (qty >= 6000) return 0.35;
  if (qty >= 3000) return 0.55;
  return 0.7;
}

/** Minimum order quantity: Hangtags 1000, Labels & Patches 500. */
export const LABEL_MOQ = 500;
export const HANGTAG_MOQ = 1000;

/**
 * Resolve the MOQ for a product from its handle — hangtags require 1000, every
 * other product 500. Mirrors the finalize page's `MIN_QTY` logic.
 */
export function minQtyFor(productHandle?: string | null): number {
  return productHandle && /hang/i.test(productHandle) ? HANGTAG_MOQ : LABEL_MOQ;
}

/**
 * Base price for a whole run of `qty` labels, in rupees (unrounded).
 *
 * @param lengthMm  Long edge (mm)
 * @param widthMm   Short edge (mm)
 * @param material  Woven | Cotton | Satin | Taffeta
 * @param qty       Total quantity (defaults to the 500-unit MOQ)
 * @param opts.quality        Quality tier — Satin's "Premium" doubles the price
 * @param opts.hasBackPanel   Two-sided design → ×1.5
 * @param opts.productHandle  Product handle — hang-tags bypass the material
 *                            math entirely (see below)
 * @param opts.thickness      Hangtag thickness — "1200 gsm" adds +75% (×1.75);
 *                            "600 gsm" is the base. Ignored for non-hangtags.
 */
export function calculateBasePrice(
  lengthMm: number,
  widthMm: number,
  material: Material,
  qty: number = 500,
  opts: {
    quality?: Quality;
    hasBackPanel?: boolean;
    productHandle?: string | null;
    thickness?: string | null;
  } = {}
): number {
  const L = Number(lengthMm);
  const W = Number(widthMm);
  const q = Number(qty);
  if (!isFinite(L) || !isFinite(W) || !isFinite(q) || L <= 0 || W <= 0 || q <= 0) {
    return 0;
  }

  // ── Hangtags: universal manufacturing formula (mirrors the finalize page) ─
  // Per-tag base = ((L × W) / 645) × a tiered rate, then × qty, +50% for a
  // two-sided design, and +75% for 1200 gsm thickness. The 600 gsm base and the
  // other add-ons (Coating/UV/Thread) are already included — no quality tier.
  // Detection mirrors Liquid's `/hang/i.test(paramProduct)`.
  if (opts.productHandle && /hang/i.test(opts.productHandle)) {
    const areaFactor = (L * W) / 645;
    let hangtagTotal = areaFactor * hangtagRate(q) * q;
    if (opts.hasBackPanel) hangtagTotal *= 1.5;
    if (opts.thickness === "1200 gsm") hangtagTotal *= 1.75;
    return hangtagTotal;
  }

  const areaFactor = (L * W) / 645;
  let perLabel = areaFactor * materialRate(material, q);
  // Woven keeps its historic +30% markup; the printed materials don't.
  if (material === "Woven") perLabel *= 1.3;

  let total = perLabel * q;

  // Quality: Satin's top tier DOUBLES instead of the standard ×1.60.
  const quality = opts.quality ?? "Basic";
  if (quality === "High") total *= 1.25;
  else if (quality === "Premium") total *= material === "Satin" ? 2 : 1.6;

  // Two-sided design bills at +50%.
  if (opts.hasBackPanel) total *= 1.5;

  return total;
}

/** Convenience: the rounded rupee figure the UI displays. */
export function formatPrice(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}
