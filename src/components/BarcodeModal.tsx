import { useState } from "react";
import { X } from "lucide-react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE, MM_TO_PX } from "./Workspace";
import { buildBarcodeApiUrl } from "@/lib/barcode";

/**
 * "Add a barcode" modal — generates a Code-128 barcode via the public
 * bwip-js HTTP API and drops it onto the canvas as a fabric.Image.
 * Available to every product EXCEPT woven labels (gated at the call
 * site in MorePanel).
 *
 * The API returns a PNG; we load it with `crossOrigin: "anonymous"` so
 * the resulting fabric image is export-safe (untainted canvas). Robust
 * error handling: a network failure / bad response surfaces an inline
 * error and the global warning toast rather than silently doing nothing.
 */
export function BarcodeModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const setCanvasWarning = useCanvasStore((s) => s.setCanvasWarning);

  if (!open) return null;

  const trimmed = text.trim();
  const isValid = trimmed.length > 0;

  const handleAdd = async () => {
    if (!canvas || !isValid) return;
    setBusy(true);
    setError(null);
    try {
      // Default new barcodes to black bars on white. Colours are then
      // editable from the contextual toolbar once selected.
      const barColor = "#000000";
      const barBgColor = "#ffffff";
      const barHasBg = true;
      const url = buildBarcodeApiUrl(trimmed, {
        barColor,
        bgColor: barBgColor,
        hasBg: barHasBg,
      });

      // Pre-flight fetch so we can detect a non-200 / network failure
      // and give a clear message BEFORE handing the URL to fabric.
      const resp = await fetch(url, { mode: "cors" });
      if (!resp.ok) {
        throw new Error(`Barcode service returned ${resp.status}`);
      }
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);

      await new Promise<void>((resolve, reject) => {
        fabric.Image.fromURL(
          objectUrl,
          (img) => {
            if (!img || !img.width) {
              reject(new Error("Could not decode barcode image"));
              return;
            }
            // Default footprint: 70% of the trim WIDTH (barcodes are
            // wide + short). Scale down if it would overflow the bleed.
            const targetW = lengthMm * MM_TO_PX * 0.7;
            const scale = targetW / (img.width || 1);
            img.set({
              left: VIRTUAL_SIZE / 2,
              top: VIRTUAL_SIZE / 2,
              originX: "center",
              originY: "center",
              scaleX: scale,
              scaleY: scale,
            });
            // Stamp metadata so the toolbar can recolour + re-fetch.
            (img as any).barcodeText = trimmed;
            (img as any).barColor = barColor;
            (img as any).barBgColor = barBgColor;
            (img as any).barHasBg = barHasBg;
            canvas.add(img);
            canvas.setActiveObject(img);
            canvas.requestRenderAll();
            URL.revokeObjectURL(objectUrl);
            resolve();
          },
          { crossOrigin: "anonymous" }
        );
      });
      onClose();
      setText("");
    } catch (e) {
      console.warn("[BarcodeModal] generation failed:", e);
      setError(
        "Couldn't generate the barcode. Check the text and your connection, then try again."
      );
      setCanvasWarning("Barcode generation failed — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-vp-pop w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 flex items-center justify-between px-4 border-b border-vp-border">
          <h2 className="font-semibold text-sm">Add a barcode</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="p-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium mb-1">
              Barcode content
            </span>
            <input
              type="text"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. 012345678905"
              autoFocus
              className="w-full h-10 px-3 rounded-md border border-vp-border text-sm focus:outline-none focus:border-vp-blue"
            />
          </label>
          <p className="text-xs text-vp-muted">
            We'll generate a scannable Code-128 barcode from this text.
          </p>
          {error && (
            <p className="text-xs text-red-600 font-medium">{error}</p>
          )}
        </div>
        <footer className="border-t border-vp-border p-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-9 px-4 rounded-md border border-vp-border text-sm hover:bg-vp-rail"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!isValid || busy}
            className="h-9 px-5 rounded-md bg-vp-blue hover:bg-vp-blue-hover disabled:bg-vp-blue/40 disabled:cursor-not-allowed text-white text-sm font-medium"
          >
            {busy ? "Generating…" : "Add Barcode"}
          </button>
        </footer>
      </div>
    </div>
  );
}
