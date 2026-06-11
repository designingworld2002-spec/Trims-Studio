import { useEffect, useRef, useState } from "react";
import {
  CloudUpload,
  Layout,
  QrCode,
  Trash2,
  X,
} from "lucide-react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE, MM_TO_PX } from "./Workspace";
import {
  deleteAsset,
  fetchRecentUploads,
  uploadAsset,
  type RecentUpload,
} from "@/lib/supabaseQueries";
import { isSupabaseConfigured } from "@/lib/supabase";

/**
 * Centered, two-pane "Upload your design" modal — opens automatically
 * when the studio launches in `mode=upload`, mirroring the standard
 * Vistaprint flow.
 *
 *   LEFT pane  — large dropzone + "Upload from this device" + "Upload
 *                from phone" buttons. Drag-and-drop is wired here.
 *   RIGHT pane — "Specs and templates" link, then either
 *                "Your uploaded files will appear here…" empty state
 *                or a grid of the customer's recently-uploaded assets
 *                fetched from Supabase Storage. Each tile has a hover
 *                trash button that permanently deletes the file.
 */
export function UploadCenterModal() {
  const open = useCanvasStore((s) => s.uploadModalOpen);
  const close = useCanvasStore((s) => s.setUploadModalOpen);
  const canvas = useCanvasStore((s) => s.canvas);
  const customerId = useCanvasStore((s) => s.customerId);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);

  const [uploads, setUploads] = useState<RecentUpload[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* --- load recent uploads when the modal opens --- */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setError(null);
      if (!customerId || !isSupabaseConfigured()) {
        setUploads([]);
        return;
      }
      const result = await fetchRecentUploads(customerId);
      if (cancelled) return;
      setUploads(result.uploads);
      if (result.error) setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, customerId]);

  if (!open) return null;

  /* --- drop a Supabase URL or dataURL onto the canvas --- */
  const placeImageOnCanvas = (src: string) => {
    if (!canvas) return;
    fabric.Image.fromURL(
      src,
      (img) => {
        const trimW = lengthMm * MM_TO_PX;
        const trimH = widthMm * MM_TO_PX;
        const target = Math.min(trimW, trimH) * 0.7;
        const iw = img.width || target;
        const ih = img.height || target;
        const scale = target / Math.max(iw, ih);
        img.set({
          left: VIRTUAL_SIZE / 2,
          top: VIRTUAL_SIZE / 2,
          originX: "center",
          originY: "center",
          scaleX: scale,
          scaleY: scale,
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.requestRenderAll();
        close(false);
      },
      { crossOrigin: "anonymous" }
    );
  };

  /* --- handle a file picked from <input> or dropped --- */
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;

      // Render onto the canvas immediately via dataURL — we don't want to
      // block on the network round-trip.
      const reader = new FileReader();
      const dataUrlPromise = new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
      });
      reader.readAsDataURL(file);
      const dataUrl = await dataUrlPromise;
      placeImageOnCanvas(dataUrl);

      // Then push to Supabase storage IF the user is signed in. Anon
      // users get the canvas drop without persistence — same Vistaprint
      // pattern.
      if (customerId && isSupabaseConfigured()) {
        const saved = await uploadAsset(customerId, file);
        if (saved) {
          setUploads((prev) => [saved, ...(prev ?? [])]);
        } else {
          setError(
            "Couldn't save to your library — the design is on the canvas though."
          );
        }
      }
    }
    setBusy(false);
  };

  const handleDelete = async (path: string) => {
    if (!window.confirm("Delete this upload from your library? This can't be undone."))
      return;
    const ok = await deleteAsset(path);
    if (ok) {
      setUploads((prev) => (prev ? prev.filter((u) => u.path !== path) : prev));
    } else {
      setError("Couldn't delete that file. Try again in a moment.");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload your design"
      className="fixed inset-0 z-50 bg-vp-ink/40 flex items-center justify-center p-4"
      onClick={() => close(false)}
    >
      <div
        className="bg-white rounded-xl shadow-vp-pop w-full max-w-5xl max-h-[92vh] overflow-hidden grid grid-cols-1 md:grid-cols-2 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          aria-label="Close"
          onClick={() => close(false)}
          className="absolute top-3 right-3 w-8 h-8 rounded-full hover:bg-vp-rail flex items-center justify-center z-10"
        >
          <X className="w-4 h-4" />
        </button>

        {/* LEFT pane — dropzone */}
        <div className="p-6 md:p-8 border-r border-vp-border">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
            className={[
              "relative rounded-2xl border-2 transition-colors flex flex-col items-center justify-center gap-3 min-h-[360px] p-6",
              dragOver
                ? "border-vp-blue bg-vp-blue-light/40"
                : "border-vp-border bg-white",
            ].join(" ")}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="h-11 px-5 rounded-full bg-vp-blue-light border-2 border-vp-blue text-vp-blue font-medium text-sm flex items-center gap-2 hover:bg-vp-blue/10"
            >
              <CloudUpload className="w-4 h-4" />
              {busy ? "Uploading…" : "Upload from this device"}
            </button>
            <button
              disabled
              className="h-11 px-5 rounded-full bg-white border border-vp-border text-vp-ink font-medium text-sm flex items-center gap-2 opacity-70 cursor-not-allowed"
              title="Coming soon"
            >
              <QrCode className="w-4 h-4" />
              Upload from phone
            </button>
            <p className="text-xs text-vp-muted mt-1">or drag and drop here</p>
          </div>
        </div>

        {/* RIGHT pane — header + uploads grid */}
        <div className="p-6 md:p-8 overflow-y-auto vp-scroll max-h-[92vh]">
          <h2 className="text-xl font-semibold mb-4">Upload your design</h2>

          <a
            href="https://trims.in/pages/specs-and-templates"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between border-b border-vp-border pb-3 mb-4 text-sm font-medium hover:text-vp-blue"
          >
            <span className="flex items-center gap-2">
              <Layout className="w-4 h-4" />
              Specs and templates
            </span>
            <span className="text-vp-muted">›</span>
          </a>

          {error && (
            <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* Uploads grid */}
          <UploadGrid
            uploads={uploads}
            customerId={customerId}
            supabaseConfigured={isSupabaseConfigured()}
            onUseImage={(url) => placeImageOnCanvas(url)}
            onDelete={handleDelete}
          />
        </div>
      </div>
    </div>
  );
}

function UploadGrid({
  uploads,
  customerId,
  supabaseConfigured,
  onUseImage,
  onDelete,
}: {
  uploads: RecentUpload[] | null;
  customerId: string | null;
  supabaseConfigured: boolean;
  onUseImage: (url: string) => void;
  onDelete: (path: string) => void;
}) {
  if (!supabaseConfigured) {
    return (
      <div className="text-sm text-vp-muted text-center py-12">
        Sign in to keep your uploaded files for next time.
      </div>
    );
  }
  if (!customerId) {
    return (
      <div className="text-sm text-vp-muted text-center py-12">
        Sign in to keep your uploaded files for next time.
      </div>
    );
  }
  if (uploads === null) {
    return (
      <div className="text-sm text-vp-muted text-center py-12">Loading…</div>
    );
  }
  if (uploads.length === 0) {
    return (
      <div className="text-sm text-vp-muted text-center py-16">
        Your uploaded files will appear here once you add them
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {uploads.map((u) => (
        <div
          key={u.path}
          className="group relative aspect-square rounded border border-vp-border overflow-hidden bg-vp-rail"
        >
          <button
            onClick={() => onUseImage(u.url)}
            className="absolute inset-0 w-full h-full"
            title="Add to canvas"
          >
            <img
              src={u.url}
              alt={u.name}
              className="w-full h-full object-contain"
              loading="lazy"
            />
          </button>
          <button
            onClick={() => onDelete(u.path)}
            aria-label="Delete upload"
            title="Delete from your library"
            className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-white/90 border border-vp-border text-red-600 hover:bg-red-50 hover:border-red-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
