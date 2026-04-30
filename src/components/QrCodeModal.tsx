import { useState } from "react";
import { X } from "lucide-react";
import QRCode from "qrcode";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE, MM_TO_PX } from "./Workspace";

/**
 * "Add a web address" modal — generates a scannable QR code as a PNG and
 * drops it onto the canvas as a fabric.Image. Disabled at the call site
 * for products too small to carry a usable QR (woven labels).
 */
export function QrCodeModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("https://www.example.com/");
  const [busy, setBusy] = useState(false);
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);

  if (!open) return null;

  const isValid = /^https?:\/\/.+\..+/i.test(url.trim());

  const handleAdd = async () => {
    if (!canvas || !isValid) return;
    setBusy(true);
    try {
      const dataUrl = await QRCode.toDataURL(url.trim(), {
        width: 512,
        margin: 1,
        errorCorrectionLevel: "M",
      });
      await new Promise<void>((resolve) => {
        fabric.Image.fromURL(dataUrl, (img) => {
          // Default footprint: 30% of the shorter trim axis.
          const target = Math.min(lengthMm, widthMm) * MM_TO_PX * 0.3;
          const scale = target / (img.width || 512);
          img.set({
            left: VIRTUAL_SIZE / 2,
            top: VIRTUAL_SIZE / 2,
            originX: "center",
            originY: "center",
            scaleX: scale,
            scaleY: scale,
          });
          // Tag it so future code can identify QR images for re-encoding.
          (img as any).qrUrl = url.trim();
          canvas.add(img);
          canvas.setActiveObject(img);
          canvas.requestRenderAll();
          resolve();
        });
      });
      onClose();
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
          <h2 className="font-semibold text-sm">Add a web address</h2>
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
            <span className="block text-xs font-medium mb-1">URL</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.example.com/"
              autoFocus
              className="w-full h-10 px-3 rounded-md border border-vp-border text-sm focus:outline-none focus:border-vp-blue"
            />
          </label>
          <p className="text-xs text-vp-muted">
            We'll generate a scannable QR linking to this address.
          </p>
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
            {busy ? "Generating…" : "Add QR Code"}
          </button>
        </footer>
      </div>
    </div>
  );
}
