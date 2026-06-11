import { RefreshCw, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE, MM_TO_PX } from "../Workspace";
import {
  deleteAsset,
  fetchRecentUploads,
  uploadAsset,
  type RecentUpload,
} from "@/lib/supabaseQueries";
import { isSupabaseConfigured } from "@/lib/supabase";

/**
 * Sidebar uploads. Mirrors the right-pane behaviour of the centered
 * UploadCenterModal: signed-in users see their full Supabase library
 * (with delete-on-hover); anonymous users see only the local-session
 * thumbnails from this tab.
 */
export function UploadsPanel() {
  const canvas = useCanvasStore((s) => s.canvas);
  const customerId = useCanvasStore((s) => s.customerId);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const inputRef = useRef<HTMLInputElement>(null);

  // Local-session thumbnails (covers anon users + zero-latency UI).
  const [localThumbs, setLocalThumbs] = useState<string[]>([]);
  // Server-side library, lazily fetched when this tab is opened.
  const [remote, setRemote] = useState<RecentUpload[] | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshRemote = async () => {
    if (!customerId || !isSupabaseConfigured()) {
      setRemote([]);
      setRemoteError(null);
      return;
    }
    setRefreshing(true);
    const res = await fetchRecentUploads(customerId);
    setRemote(res.uploads);
    setRemoteError(res.error);
    setRefreshing(false);
  };

  useEffect(() => {
    let cancelled = false;
    if (!customerId || !isSupabaseConfigured()) {
      setRemote([]);
      setRemoteError(null);
      return;
    }
    setRefreshing(true);
    fetchRecentUploads(customerId).then((res) => {
      if (cancelled) return;
      setRemote(res.uploads);
      setRemoteError(res.error);
      setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const placeOnCanvas = (src: string) => {
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
      },
      { crossOrigin: "anonymous" }
    );
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !canvas) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      // Local thumbnail + immediate canvas placement.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      setLocalThumbs((t) => [dataUrl, ...t].slice(0, 24));
      placeOnCanvas(dataUrl);
      // Persist for signed-in users.
      if (customerId && isSupabaseConfigured()) {
        const saved = await uploadAsset(customerId, file);
        if (saved) {
          setRemote((prev) => [saved, ...(prev ?? [])]);
          setRemoteError(null);
        } else {
          setRemoteError(
            "Couldn't save to your library. Check that the Storage bucket exists and the anon role has INSERT + SELECT policies on it."
          );
        }
      }
    }
  };

  const handleDelete = async (path: string) => {
    if (!window.confirm("Delete this upload from your library?")) return;
    const ok = await deleteAsset(path);
    if (ok) setRemote((prev) => (prev ? prev.filter((u) => u.path !== path) : prev));
  };

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="w-full h-11 rounded-md bg-vp-blue hover:bg-vp-blue-hover text-white text-sm font-medium flex items-center justify-center gap-2"
      >
        <Upload className="w-4 h-4" />
        Upload from this device
      </button>

      {!customerId && (
        <div className="text-xs text-vp-muted text-center py-1">
          Sign in to access previous uploads
        </div>
      )}

      {/* Surface any Supabase Storage error so the merchant can spot a
          missing policy / bucket misconfiguration instead of seeing an
          empty grid and assuming the upload silently failed. */}
      {remoteError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 leading-snug">
          {remoteError}
        </div>
      )}

      {/* Server library (signed-in only) — always renders the header so the
          merchant has a visible Refresh button and a "no uploads" state to
          confirm the bucket query worked, instead of guessing whether the
          panel is just slow. */}
      {customerId && isSupabaseConfigured() && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase tracking-wide text-vp-muted font-semibold">
              Your library
              {remote && remote.length > 0 && (
                <span className="ml-1 text-vp-muted">({remote.length})</span>
              )}
            </div>
            <button
              onClick={refreshRemote}
              aria-label="Refresh uploads"
              title="Refresh"
              className="w-6 h-6 rounded hover:bg-vp-rail flex items-center justify-center text-vp-muted"
            >
              <RefreshCw
                className={[
                  "w-3 h-3",
                  refreshing ? "animate-spin" : "",
                ].join(" ")}
              />
            </button>
          </div>
          {remote === null || (refreshing && (remote?.length ?? 0) === 0) ? (
            <div className="text-xs text-vp-muted text-center py-4">
              Loading…
            </div>
          ) : remote.length === 0 ? (
            <div className="text-xs text-vp-muted text-center py-4">
              No uploads yet.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {remote.map((u) => (
                <div
                  key={u.path}
                  className="group relative aspect-square rounded border border-vp-border overflow-hidden bg-vp-rail"
                >
                  <button
                    onClick={() => placeOnCanvas(u.url)}
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
                    onClick={() => handleDelete(u.path)}
                    aria-label="Delete upload"
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-white/90 border border-vp-border text-red-600 hover:bg-red-50 flex items-center justify-center opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Local-session thumbnails (always shown, includes anon flow) */}
      {localThumbs.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-vp-muted font-semibold mb-1.5">
            This session
          </div>
          <div className="grid grid-cols-3 gap-2">
            {localThumbs.map((src, i) => (
              <button
                key={i}
                onClick={() => placeOnCanvas(src)}
                className="aspect-square rounded border border-vp-border overflow-hidden bg-vp-rail hover:border-vp-blue"
              >
                <img src={src} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
