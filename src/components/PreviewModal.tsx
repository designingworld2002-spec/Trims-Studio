import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { saveDesign } from "@/lib/saveDesign";

/**
 * Final review modal.
 *
 * Renders a PNG snapshot of the trim, asks for authorization, then on
 * Continue uploads the PNG + raw fabric JSON to Supabase and redirects to
 * the Shopify finalize page with `?design_id=…&preview_url=…&…`.
 */
export function PreviewModal() {
  const open = useCanvasStore((s) => s.previewOpen);
  const setOpen = useCanvasStore((s) => s.setPreviewOpen);
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const productTitle = useCanvasStore((s) => s.productTitle);
  const productSlug = useCanvasStore((s) => s.productSlug);
  const customerId = useCanvasStore((s) => s.customerId);
  const workId = useCanvasStore((s) => s.workId);
  const templateId = useCanvasStore((s) => s.templateId);

  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !canvas) return;
    // The bleed rect IS the visible card (it carries the user's background
    // colour in the new model), so we keep it during the snapshot. We only
    // need to hide the dashed safety guide + temporarily strip the bleed's
    // own dashed yellow stroke so the export looks like the printed card.
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

    const trimW = lengthMm * 10;
    const trimH = widthMm * 10;
    const cx = 1000;
    const cy = 1000;
    const url = canvas.toDataURL({
      format: "png",
      left: cx - trimW / 2,
      top: cy - trimH / 2,
      width: trimW,
      height: trimH,
      multiplier: 1,
    });
    setDataUrl(url);

    if (safety) safety.set("opacity", prevSafetyOpacity);
    if (bleed)
      bleed.set({
        stroke: prevBleedStroke as any,
        strokeWidth: prevBleedStrokeWidth as any,
      });
    canvas.renderAll();
  }, [open, canvas, lengthMm, widthMm]);

  if (!open) return null;

  const handleContinue = async () => {
    if (!canvas) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await saveDesign({
        canvas,
        lengthMm,
        widthMm,
        productSlug,
        productTitle,
        customerId,
        workId,
        templateId,
      });
      // Redirect the storefront back to /pages/finalize.
      window.location.href = result.finalizeUrl;
    } catch (e: any) {
      console.error("[trims-studio] save failed:", e);
      setError(e?.message || "Save failed. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={() => !submitting && setOpen(false)}
    >
      <div
        className="bg-white rounded-lg shadow-vp-pop max-w-3xl w-full max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 flex items-center justify-between px-4 border-b border-vp-border">
          <h2 className="font-semibold text-sm">Review your design</h2>
          <button
            aria-label="Close"
            onClick={() => !submitting && setOpen(false)}
            disabled={submitting}
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 sm:p-6 flex-1 overflow-y-auto vp-scroll">
          <p className="text-sm text-vp-muted mb-4">
            It will be printed like this preview. Make sure you are happy
            before continuing.
          </p>

          {dataUrl && (
            <div className="bg-vp-rail rounded p-4 sm:p-6 flex items-center justify-center mb-6">
              <img
                src={dataUrl}
                alt="Design preview"
                className="max-w-full max-h-[50vh] shadow-vp-card"
                style={{
                  aspectRatio: `${lengthMm} / ${widthMm}`,
                }}
              />
            </div>
          )}

          <ul className="text-sm space-y-1.5 text-vp-ink/80 mb-4">
            <li>• Are the text and images clear and easy to read?</li>
            <li>• Do the design elements fit in the safety area?</li>
            <li>• Does the background fill out to the edges?</li>
            <li>• Is everything spelled correctly?</li>
          </ul>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(e) => setAuthorized(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I have authorization to use the design. I have reviewed and
              approve it.
            </span>
          </label>

          {error && (
            <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <footer className="border-t border-vp-border p-3 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
          <span className="text-xs text-vp-muted">
            {productTitle} · {lengthMm} × {widthMm} mm
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setOpen(false)}
              disabled={submitting}
              className="h-9 px-4 rounded-md border border-vp-border text-sm hover:bg-vp-rail disabled:opacity-40"
            >
              Edit my design
            </button>
            <button
              onClick={handleContinue}
              disabled={!authorized || submitting}
              className="h-9 px-5 rounded-md bg-vp-blue hover:bg-vp-blue-hover disabled:bg-vp-blue/40 disabled:cursor-not-allowed text-white text-sm font-medium flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Saving…
                </>
              ) : (
                "Continue"
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
