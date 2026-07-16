import { useEffect, useMemo, useState } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { readUrlConfig } from "@/lib/urlParams";
import {
  MATERIALS,
  MATERIAL_LABELS,
  calculateBasePrice,
  formatPrice,
  type Material,
} from "@/lib/pricing";

/** Every quote in the Studio is shown against the 500-unit MOQ. */
const QUOTE_QTY = 500;

interface SizeOption {
  /** Pill label — the anchored Width (standard tape width). */
  label: string;
  /** Width (mm) — the SHORT edge, anchored by the pill. */
  widthMm: number;
  /** Length (mm) — derived from the initial URL ratio, ratio-locked. */
  lengthMm: number;
}

/** "18.75" / "42" — trims trailing zeros for the pill captions. */
function fmtMm(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * First-touch setup for products whose size + material aren't implied by the
 * product itself (washcare-labels / size-labels). Opened from `main.tsx` on
 * load; on Continue it writes the chosen Length × Width + material into the
 * store (material also re-derives the product's capabilities) and reveals
 * the workspace.
 *
 * Sizes are STRICTLY fixed pills that anchor the WIDTH (the standard tape
 * widths — washcare: 28/32/40/50 mm · size: 12/15/20 mm). The LENGTH is
 * derived dynamically from the dimensions the Studio was opened with (the
 * URL's `length` / `width` params, falling back to the product defaults) so
 * every pill preserves the exact initial aspect ratio — nothing hardcoded.
 */
export function MaterialSetupModal() {
  const open = useCanvasStore((s) => s.materialSetupOpen);
  const setOpen = useCanvasStore((s) => s.setMaterialSetupOpen);
  const setCanvasSize = useCanvasStore((s) => s.setCanvasSize);
  const setMaterial = useCanvasStore((s) => s.setMaterial);
  const storeMaterial = useCanvasStore((s) => s.material);
  const storeWidth = useCanvasStore((s) => s.canvasWidthMm);
  const productConfig = useCanvasStore((s) => s.productConfig);
  const productTitle = useCanvasStore((s) => s.productTitle);

  // ── Baseline ratio: the INITIAL URL dimensions ──────────────────────────
  // `readUrlConfig` is the Studio's canonical URL parser (handles the legacy
  // `?width/height` form too) and falls back to the product's defaults when
  // the URL omits dimensions. Ratio = initialLength / initialWidth.
  const { pillWidths, ratio } = useMemo(() => {
    const cfg = readUrlConfig(productConfig.defaultDimensions);
    const r = cfg.widthMm > 0 ? cfg.lengthMm / cfg.widthMm : 1;
    const widths =
      productConfig.presetSizes && productConfig.presetSizes.length > 0
        ? productConfig.presetSizes.map((p) => ({
            label: p.label,
            widthMm: p.widthMm,
          }))
        : [{ label: "Standard", widthMm: cfg.widthMm }];
    return { pillWidths: widths, ratio: r };
  }, [productConfig]);

  // Fixed pills: Width anchored to the stock value, Length ratio-locked to
  // the initial URL proportions (kept to 2 decimals, never snapped).
  const sizeOptions: SizeOption[] = useMemo(
    () =>
      pillWidths.map((p) => ({
        label: `${p.widthMm} mm`,
        widthMm: p.widthMm,
        lengthMm: Math.round(p.widthMm * ratio * 100) / 100,
      })),
    [pillWidths, ratio]
  );

  // Default pill: the one matching the current canvas Width, else the
  // "Standard" preset, else the first.
  const defaultIndex = useMemo(() => {
    const byCurrent = sizeOptions.findIndex((o) => o.widthMm === storeWidth);
    if (byCurrent >= 0) return byCurrent;
    const byLabel = pillWidths.findIndex((p) => p.label === "Standard");
    return byLabel >= 0 ? byLabel : 0;
  }, [sizeOptions, pillWidths, storeWidth]);

  const [sizeIndex, setSizeIndex] = useState(defaultIndex);
  const [material, setLocalMaterial] = useState<Material>(storeMaterial);

  // Re-seed the draft whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setSizeIndex(defaultIndex);
    setLocalMaterial(storeMaterial);
  }, [open, defaultIndex, storeMaterial]);

  if (!open) return null;

  const size = sizeOptions[Math.min(sizeIndex, sizeOptions.length - 1)];
  // Length / Width map 1:1 onto the pricing engine's (lengthMm, widthMm).
  const price = calculateBasePrice(
    size.lengthMm,
    size.widthMm,
    material,
    QUOTE_QTY,
    { productHandle: productConfig.handle }
  );

  const onContinue = () => {
    // Length / Width land in the store exactly as derived — the finalize
    // redirect then forwards them via `?length=` / `?width=` unchanged.
    setCanvasSize(size.lengthMm, size.widthMm);
    setMaterial(material);
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="material-setup-title"
      className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
    >
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-vp-border overflow-hidden">
        <header className="px-7 pt-7 pb-4">
          <h2
            id="material-setup-title"
            className="text-[19px] font-semibold tracking-tight text-vp-ink"
          >
            Set up your {productTitle}
          </h2>
          <p className="text-[13px] text-vp-muted mt-1.5">
            Pick a stock size and material to get started.
          </p>
        </header>

        {/* Fixed stock sizes — Width anchored, Length ratio-locked */}
        <section className="px-7">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-vp-muted mb-1">
            Size
          </h3>
          <p className="text-[11px] text-vp-muted mb-2.5">
            Shown as Length × Width — locked to your design's original
            proportions.
          </p>
          <div className="flex flex-wrap gap-2">
            {sizeOptions.map((o, i) => {
              const active = i === sizeIndex;
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setSizeIndex(i)}
                  aria-pressed={active}
                  className={[
                    "flex flex-col items-center justify-center min-w-[92px] px-4 py-2.5 rounded-xl border transition-all",
                    active
                      ? "bg-vp-ink text-white border-vp-ink shadow-sm"
                      : "bg-white text-vp-ink/75 border-vp-border hover:border-vp-ink hover:text-vp-ink",
                  ].join(" ")}
                >
                  <span className="text-[14px] font-semibold leading-tight">
                    {o.label}
                  </span>
                  <span
                    className={[
                      "text-[10.5px] leading-tight mt-0.5 tabular-nums",
                      active ? "text-white/75" : "text-vp-muted",
                    ].join(" ")}
                  >
                    {fmtMm(o.lengthMm)} × {fmtMm(o.widthMm)} mm
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Material */}
        <section className="px-7 mt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-vp-muted mb-2">
            Material
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {MATERIALS.map((m) => {
              const active = m === material;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setLocalMaterial(m)}
                  aria-pressed={active}
                  className={[
                    "h-11 px-4 rounded-full border text-[13px] font-semibold transition-all",
                    active
                      ? "bg-vp-ink text-white border-vp-ink shadow-sm"
                      : "bg-white text-vp-ink/75 border-vp-border hover:border-vp-ink hover:text-vp-ink",
                  ].join(" ")}
                >
                  {MATERIAL_LABELS[m]}
                </button>
              );
            })}
          </div>
        </section>

        {/* Live price */}
        <section className="px-7 mt-6">
          <div className="flex items-baseline justify-between rounded-xl bg-vp-rail border border-vp-border px-4 py-3.5">
            <span className="text-[12.5px] font-medium text-vp-muted">
              Estimated price
            </span>
            <span className="text-[16px] font-bold text-vp-ink tabular-nums">
              Rs. {formatPrice(price)}{" "}
              <span className="text-[12px] font-medium text-vp-muted">
                / {QUOTE_QTY} units
              </span>
            </span>
          </div>
          <p className="text-[11px] text-vp-muted mt-2 leading-snug">
            Base material price. Finishing options (fold / cut) and a back side
            are priced at checkout.
          </p>
        </section>

        <footer className="px-7 py-6 mt-2">
          <button
            type="button"
            onClick={onContinue}
            className="w-full h-12 rounded-full bg-vp-blue hover:bg-vp-blue-hover text-white text-[14px] font-semibold tracking-wide shadow-sm hover:shadow-md transition-all"
          >
            Continue
          </button>
        </footer>
      </div>
    </div>
  );
}
