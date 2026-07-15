import { useEffect, useState } from "react";
import { Link as LinkIcon, Unlink } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import {
  MATERIALS,
  MATERIAL_LABELS,
  calculateBasePrice,
  formatPrice,
  type Material,
} from "@/lib/pricing";

/** Every quote in the Studio is shown against the 500-unit MOQ. */
const QUOTE_QTY = 500;

/**
 * First-touch setup for products whose size + material aren't implied by the
 * product itself (washcare-labels / size-labels). Opened from `main.tsx` on
 * load; on Continue it writes the chosen dimensions + material into the store
 * and reveals the workspace.
 *
 * Dimension naming matches the Studio's URL convention:
 *   Width  → `canvasLengthMm` (X / horizontal)
 *   Height → `canvasWidthMm`  (Y / vertical)
 */
export function MaterialSetupModal() {
  const open = useCanvasStore((s) => s.materialSetupOpen);
  const setOpen = useCanvasStore((s) => s.setMaterialSetupOpen);
  const setCanvasSize = useCanvasStore((s) => s.setCanvasSize);
  const setMaterial = useCanvasStore((s) => s.setMaterial);
  const storeMaterial = useCanvasStore((s) => s.material);
  const storeLength = useCanvasStore((s) => s.canvasLengthMm);
  const storeWidth = useCanvasStore((s) => s.canvasWidthMm);
  const productTitle = useCanvasStore((s) => s.productTitle);

  // Draft state — seeded from the product's preset default dimensions.
  const [width, setWidth] = useState(String(storeLength));
  const [height, setHeight] = useState(String(storeWidth));
  const [locked, setLocked] = useState(true);
  const [ratio, setRatio] = useState(
    storeWidth > 0 ? storeLength / storeWidth : 1
  );
  const [material, setLocalMaterial] = useState<Material>(storeMaterial);

  // Re-seed whenever the modal opens (store defaults land before this mounts,
  // but this keeps the draft honest if it's ever reopened).
  useEffect(() => {
    if (!open) return;
    setWidth(String(storeLength));
    setHeight(String(storeWidth));
    setLocalMaterial(storeMaterial);
    setRatio(storeWidth > 0 ? storeLength / storeWidth : 1);
  }, [open, storeLength, storeWidth, storeMaterial]);

  if (!open) return null;

  const w = Number(width);
  const h = Number(height);
  const valid = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  const price = valid ? calculateBasePrice(w, h, material, QUOTE_QTY) : 0;

  const onWidth = (v: string) => {
    setWidth(v);
    const n = Number(v);
    if (locked && Number.isFinite(n) && n > 0 && ratio > 0) {
      setHeight(String(Math.max(1, Math.round(n / ratio))));
    }
  };
  const onHeight = (v: string) => {
    setHeight(v);
    const n = Number(v);
    if (locked && Number.isFinite(n) && n > 0) {
      setWidth(String(Math.max(1, Math.round(n * ratio))));
    }
  };

  const toggleLock = () => {
    // Re-capture the ratio from the CURRENT values when re-engaging the lock,
    // so it locks what the user actually sees.
    if (!locked && w > 0 && h > 0) setRatio(w / h);
    setLocked((v) => !v);
  };

  const onContinue = () => {
    if (!valid) return;
    setCanvasSize(Math.round(w), Math.round(h));
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
            Pick a size and material to get started — you can change both later.
          </p>
        </header>

        {/* Dimensions */}
        <section className="px-7">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-vp-muted mb-2">
            Dimensions
          </h3>
          <div className="flex items-end gap-2">
            <label className="flex-1">
              <span className="block text-[12px] font-medium text-vp-ink/70 mb-1">
                Width
              </span>
              <div className="relative">
                <input
                  type="number"
                  min={1}
                  value={width}
                  onChange={(e) => onWidth(e.target.value)}
                  className="w-full h-11 pl-3 pr-10 rounded-lg border border-vp-border text-[14px] text-vp-ink focus:outline-none focus:ring-2 focus:ring-vp-accent/30 focus:border-vp-accent"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-vp-muted pointer-events-none">
                  mm
                </span>
              </div>
            </label>

            <button
              type="button"
              onClick={toggleLock}
              aria-pressed={locked}
              title={locked ? "Aspect ratio locked" : "Aspect ratio unlocked"}
              aria-label={
                locked ? "Unlock aspect ratio" : "Lock aspect ratio"
              }
              className={[
                "mb-0.5 flex items-center justify-center h-11 w-11 rounded-lg border transition-colors shrink-0",
                locked
                  ? "border-vp-accent bg-vp-accent/10 text-vp-accent"
                  : "border-vp-border text-vp-ink/50 hover:text-vp-ink hover:bg-vp-rail",
              ].join(" ")}
            >
              {locked ? (
                <LinkIcon className="w-4 h-4" />
              ) : (
                <Unlink className="w-4 h-4" />
              )}
            </button>

            <label className="flex-1">
              <span className="block text-[12px] font-medium text-vp-ink/70 mb-1">
                Height
              </span>
              <div className="relative">
                <input
                  type="number"
                  min={1}
                  value={height}
                  onChange={(e) => onHeight(e.target.value)}
                  className="w-full h-11 pl-3 pr-10 rounded-lg border border-vp-border text-[14px] text-vp-ink focus:outline-none focus:ring-2 focus:ring-vp-accent/30 focus:border-vp-accent"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-vp-muted pointer-events-none">
                  mm
                </span>
              </div>
            </label>
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
              {valid ? (
                <>
                  Rs. {formatPrice(price)}{" "}
                  <span className="text-[12px] font-medium text-vp-muted">
                    / {QUOTE_QTY} units
                  </span>
                </>
              ) : (
                <span className="text-[13px] font-medium text-vp-muted">
                  Enter a valid size
                </span>
              )}
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
            disabled={!valid}
            className="w-full h-12 rounded-full bg-vp-blue hover:bg-vp-blue-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-[14px] font-semibold tracking-wide shadow-sm hover:shadow-md transition-all"
          >
            Continue
          </button>
        </footer>
      </div>
    </div>
  );
}
