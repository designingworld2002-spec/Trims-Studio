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
 * Coerce anything (URL param, product handle, "Cotton Printed", …) into a
 * canonical Material. Defaults to Woven.
 */
export function normaliseMaterial(raw: string | null | undefined): Material {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("cotton")) return "Cotton";
  if (s.includes("satin")) return "Satin";
  if (s.includes("taffeta")) return "Taffeta";
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
 * Base price for a whole run of `qty` labels, in rupees (unrounded).
 *
 * @param lengthMm  Long edge (mm)
 * @param widthMm   Short edge (mm)
 * @param material  Woven | Cotton | Satin | Taffeta
 * @param qty       Total quantity (defaults to the 500-unit MOQ)
 * @param opts.quality       Quality tier — Satin's "Premium" doubles the price
 * @param opts.hasBackPanel  Two-sided design → ×1.5
 */
export function calculateBasePrice(
  lengthMm: number,
  widthMm: number,
  material: Material,
  qty: number = 500,
  opts: { quality?: Quality; hasBackPanel?: boolean } = {}
): number {
  const L = Number(lengthMm);
  const W = Number(widthMm);
  const q = Number(qty);
  if (!isFinite(L) || !isFinite(W) || !isFinite(q) || L <= 0 || W <= 0 || q <= 0) {
    return 0;
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
