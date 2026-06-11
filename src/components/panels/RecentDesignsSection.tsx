import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import {
  deleteDesign,
  fetchRecentDesigns,
  type RecentDesign,
} from "@/lib/supabaseQueries";
import { isSupabaseConfigured } from "@/lib/supabase";
import { designOps } from "../Workspace";

/**
 * Logged-in only. Lists this customer's most recently saved designs and
 * lets them load one back into the editor.
 *
 * Loading a recent design:
 *   1. Hydrates the canvas from the row's `fabric_json`.
 *   2. Resets the autosave `workId` so the next save creates a NEW row
 *      instead of overwriting the original.
 *   3. Marks `isRecentDesignLoaded` so Workspace can show the
 *      "Revert to original template" pill.
 */
export function RecentDesignsSection() {
  const customerId = useCanvasStore((s) => s.customerId);
  const setWorkId = useCanvasStore((s) => s.setWorkId);
  const setRecentDesignLoaded = useCanvasStore((s) => s.setRecentDesignLoaded);
  const [items, setItems] = useState<RecentDesign[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!customerId || !isSupabaseConfigured()) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchRecentDesigns(customerId).then((res) => {
      if (cancelled) return;
      setItems(res);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  // Hide the section entirely for anonymous users.
  if (!customerId || !isSupabaseConfigured()) return null;

  const onPick = async (d: RecentDesign) => {
    // Load via the designOps facade — pauses history, swaps canvas
    // content, redraws guides, reapplies safe-area clip, takes one
    // snapshot.
    await designOps.loadJson(d.fabric_json, d.length_mm, d.width_mm);
    // Treat this as a brand-new editing session: clear workId so the
    // next autosave POSTs a new row. Mark recent-loaded for the revert pill.
    setWorkId(null);
    setRecentDesignLoaded(true);
  };

  /**
   * Permanently delete a saved design row + its preview PNG.
   *
   * UX: optimistic update — we drop the tile from the local list FIRST
   * (so the gallery feels instant), then call the server. If the server
   * call fails we revert by re-fetching the canonical list and surface
   * a small toast-style error.
   */
  const onDelete = async (
    e: React.MouseEvent,
    d: RecentDesign
  ): Promise<void> => {
    // Don't let the click bubble to the parent <button> that loads the
    // design — the user wanted to delete, not load.
    e.preventDefault();
    e.stopPropagation();
    if (
      !window.confirm(
        `Delete "${d.product_title ?? "this design"}" permanently? This can't be undone.`
      )
    ) {
      return;
    }
    const snapshot = items;
    setItems((prev) => (prev ? prev.filter((x) => x.id !== d.id) : prev));
    const result = await deleteDesign(d.id, d.preview_path ?? undefined);
    if (!result.ok) {
      // Restore the optimistic removal so the UI matches the server.
      setItems(snapshot);
      window.alert(
        result.error ??
          "Couldn't delete that design. Please try again."
      );
    }
  };

  return (
    <div className="space-y-2 pt-4 border-t border-vp-border">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-vp-muted">
          Recent designs
        </h3>
        {items && items.length > 0 && (
          <span className="text-[10px] text-vp-muted">{items.length}</span>
        )}
      </div>
      {loading ? (
        <div className="text-xs text-vp-muted py-4 text-center">Loading…</div>
      ) : !items || items.length === 0 ? (
        <div className="text-xs text-vp-muted py-4 text-center">
          You haven't saved any designs yet.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {items.map((d) => (
            <div
              key={d.id}
              className="group relative aspect-[16/10] rounded border border-vp-border overflow-hidden bg-vp-rail hover:border-vp-blue"
            >
              <button
                type="button"
                onClick={() => onPick(d)}
                title={`${d.product_title ?? "Design"} · ${d.length_mm}×${d.width_mm} mm`}
                className="absolute inset-0 w-full h-full text-left flex flex-col"
              >
                {d.preview_url ? (
                  <img
                    src={d.preview_url}
                    alt=""
                    className="w-full h-full object-contain bg-white"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-[10px] text-vp-muted">
                    no preview
                  </div>
                )}
              </button>
              <button
                type="button"
                onClick={(e) => onDelete(e, d)}
                aria-label="Delete design"
                title="Delete permanently"
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-white/90 border border-vp-border text-red-600 hover:bg-red-50 hover:border-red-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
