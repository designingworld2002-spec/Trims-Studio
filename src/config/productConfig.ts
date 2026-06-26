import type { CanvasShape, ToolKey } from "@/store/canvasStore";

/**
 * Configuration-driven product architecture.
 *
 * Each Shopify product handle the Studio supports maps to a `ProductConfig`
 * that describes its physical constraints and which editor affordances are
 * enabled. The canvas engine, sidebar, and size presets all read from the
 * active config rather than hard-coding "woven label" assumptions — so
 * adding a new product (hang tags, stickers, badges…) is a matter of
 * appending an entry here, not editing the editor internals.
 */

export type CanvasClipShape =
  | "rectangle"
  | "circle"
  | "cut-corners"
  | "arch";

export interface VisualGuides {
  /** Draw a protective drill/punch-hole ring so users don't place
   *  content where the hole will be punched. */
  hasHolePunch: boolean;
  /** Punch-hole radius in mm. */
  holePunchRadiusMm: number;
  /** Distance from the TOP edge of the bleed to the hole's CENTRE, mm. */
  holePunchOffsetFromTopMm: number;
}

export interface ProductConfig {
  /** Canonical Shopify handle. */
  handle: string;
  /** Human-readable label (top bar fallback, future product switcher). */
  label: string;
  /** Tools enabled in the left rail for this product. */
  allowedTools: NonNullable<ToolKey>[];
  /** Fallback bleed dimensions when the URL omits length/width. */
  defaultDimensions: { lengthMm: number; widthMm: number };
  /** Special canvas overlays (hole punch, etc.). */
  visualGuides: VisualGuides;
  /** Intended trimmed silhouette — informs future clipPath / die-line work. */
  canvasClipShape: CanvasClipShape;
  /**
   * User-selectable silhouettes for this product. If the array has only
   * one entry, the Product panel hides the shape picker entirely (the
   * choice is fixed by the manufacturing process). The default
   * `canvasShape` is the first entry.
   */
  allowedShapes: CanvasShape[];
  /**
   * Does this product support an independent back-side design?
   *   - hang-tags: true (printed two-sided)
   *   - woven-labels: false (single woven face)
   */
  supportsBackSide: boolean;
  /**
   * CSS `background` value used by Preview Mode to overlay a material
   * texture on top of the digital design (via `mix-blend-mode: multiply`),
   * creating the optical illusion that the design is physically
   * woven/printed on the real material. Set to `null` to skip the overlay.
   *
   * Can be any valid CSS background: a `url(...)` to a seamless PNG/SVG,
   * a `repeating-linear-gradient(...)` for woven threads, a
   * `radial-gradient(...)` for paper grain, etc.
   */
  textureOverlayCss: string | null;
  /** Opacity (0–1) of the texture overlay. Higher = more material feel. */
  textureOverlayOpacity: number;
  /** Blend mode for the overlay. `multiply` reads as "ink on material". */
  textureOverlayBlendMode:
    | "multiply"
    | "overlay"
    | "soft-light"
    | "hard-light";
}

const ALL_TOOLS: NonNullable<ToolKey>[] = [
  "product",
  "text",
  "uploads",
  "graphics",
  "background",
  "more",
];

const NO_HOLE: VisualGuides = {
  hasHolePunch: false,
  holePunchRadiusMm: 0,
  holePunchOffsetFromTopMm: 0,
};

export const DEFAULT_PRODUCT_HANDLE = "woven-labels";

/**
 * Product registry. Keyed by canonical handle. `getProductConfig` below
 * normalises aliases (hangtag / hang_tags / hangtags → hang-tags).
 */
export const PRODUCT_CONFIGS: Record<string, ProductConfig> = {
  "woven-labels": {
    handle: "woven-labels",
    label: "Woven Labels",
    allowedTools: ALL_TOOLS,
    // Landscape: length (X) is the long edge.
    defaultDimensions: { lengthMm: 90, widthMm: 50 },
    visualGuides: NO_HOLE,
    canvasClipShape: "rectangle",
    // Woven looms only produce rectangular labels — no shape choice.
    allowedShapes: ["rectangle"],
    // Woven labels are typically single-faced.
    supportsBackSide: false,
    // Woven thread illusion — fine alternating warp/weft lines. Two
    // repeating gradients perpendicular to each other simulate the
    // interlace pattern at ~1px thread spacing.
    textureOverlayCss: "url('/texture-woven.png')",
    textureOverlayOpacity: 0.35,
    textureOverlayBlendMode: "multiply",
  },

  "hang-tags": {
    handle: "hang-tags",
    label: "Hang Tags",
    allowedTools: ALL_TOOLS,
    // Portrait: width (Y) is the long edge — a 50 × 90 mm tag.
    defaultDimensions: { lengthMm: 50, widthMm: 90 },
    visualGuides: {
      hasHolePunch: true,
      holePunchRadiusMm: 2.5,
      holePunchOffsetFromTopMm: 8,
    },
    canvasClipShape: "cut-corners",
    // Hang tags ship with the standard 4 die-cut silhouettes PLUS the
    // 5 premium shapes. Star is omitted at the client's request (not a
    // standard retail tag profile).
    allowedShapes: [
      "rectangle",
      "round-corners",
      "cut-corners",
      "oval",
      "scalloped",
      "pointed-top",
      "hexagon-pointed",
      "flared",
      "mixed-cut-round",
      // Extended premium set (boutique-style die-cuts)
      "boutique",
      "arch",
      "barrel",
      "pill",
      "ticket",
    ],
    // Tags print front and back.
    supportsBackSide: true,
    // Matte paper grain — soft randomized speckle built from two
    // off-center radial gradients overlaid on a fine noise gradient.
    textureOverlayCss: "url('/texture-hangtag.png')",
    textureOverlayOpacity: 0.7,
    textureOverlayBlendMode: "multiply",
  },

  // -------------------------------------------------------------------
  // Printed labels — cotton / satin / taffeta. These are flat printed
  // fabric labels (no die-cut hole punch). They share hangtag-grade
  // capabilities: full toolset, QR + Barcode, and independent
  // front/back printing. Shapes are limited to the rectangular family
  // (printed labels are guillotine-cut, not die-cut). A single shared
  // config factory keeps the three materials consistent.
  // -------------------------------------------------------------------
  ...printedLabelConfigs(),
};

/**
 * Build the three printed-label product configs from one template so
 * cotton / satin / taffeta stay perfectly in sync — they differ only
 * in handle, label, and the material texture overlay.
 */
function printedLabelConfigs(): Record<string, ProductConfig> {
  const base = (
    handle: string,
    label: string,
    texture: string,
    opacity: number
  ): ProductConfig => ({
    handle,
    label,
    allowedTools: ALL_TOOLS,
    // Printed labels are usually small landscape rectangles.
    defaultDimensions: { lengthMm: 60, widthMm: 40 },
    visualGuides: NO_HOLE,
    canvasClipShape: "rectangle",
    // Guillotine-cut, so only the rectangular family is offered.
    allowedShapes: ["rectangle", "round-corners", "cut-corners"],
    // Printed both sides, exactly like hang tags.
    supportsBackSide: true,
    textureOverlayCss: texture,
    textureOverlayOpacity: opacity,
    textureOverlayBlendMode: "multiply",
  });
  return {
    "cotton-printed-labels": base(
      "cotton-printed-labels",
      "Cotton Printed Labels",
      "url('/texture-woven.png')",
      0.32
    ),
    "satin-printed-labels": base(
      "satin-printed-labels",
      "Satin Printed Labels",
      // Satin reads smoother/glossier — lighter overlay, soft sheen.
      "url('/texture-woven.png')",
      0.18
    ),
    "taffeta-printed-labels": base(
      "taffeta-printed-labels",
      "Taffeta Printed Labels",
      "url('/texture-woven.png')",
      0.4
    ),
  };
}

/**
 * Resolve a product handle (possibly an alias or `null`) to its config,
 * falling back to the default product when unknown.
 */
export function getProductConfig(
  handle: string | null | undefined
): ProductConfig {
  if (!handle) return PRODUCT_CONFIGS[DEFAULT_PRODUCT_HANDLE];
  if (PRODUCT_CONFIGS[handle]) return PRODUCT_CONFIGS[handle];

  // Normalise common alias spellings: "hang_tags", "Hang Tags",
  // "hangtags", "hangtag" → "hang-tags".
  const norm = handle.toLowerCase().trim().replace(/[\s_]+/g, "-");
  if (PRODUCT_CONFIGS[norm]) return PRODUCT_CONFIGS[norm];
  if (norm.includes("hang")) return PRODUCT_CONFIGS["hang-tags"];

  // Printed labels — match the material keyword. Checked BEFORE the
  // generic "woven"/"label" fallback so "cotton printed labels" etc.
  // resolve to their own config (and NOT to woven-labels, which has
  // back-side + QR disabled).
  if (norm.includes("cotton"))
    return PRODUCT_CONFIGS["cotton-printed-labels"];
  if (norm.includes("satin"))
    return PRODUCT_CONFIGS["satin-printed-labels"];
  if (norm.includes("taffeta"))
    return PRODUCT_CONFIGS["taffeta-printed-labels"];
  // A generic "printed labels" (no material named) → cotton default.
  if (norm.includes("printed"))
    return PRODUCT_CONFIGS["cotton-printed-labels"];

  if (norm.includes("woven") || norm.includes("label"))
    return PRODUCT_CONFIGS["woven-labels"];

  return PRODUCT_CONFIGS[DEFAULT_PRODUCT_HANDLE];
}
