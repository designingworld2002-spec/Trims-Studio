import { useEffect, useState } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { fetchRecentDesigns, type RecentDesign } from "@/lib/supabaseQueries";
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
            <button
              key={d.id}
              onClick={() => onPick(d)}
              title={`${d.product_title ?? "Design"} · ${d.length_mm}×${d.width_mm} mm`}
              className="aspect-[16/10] rounded border border-vp-border overflow-hidden bg-vp-rail hover:border-vp-blue text-left flex flex-col"
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
          ))}
        </div>
      )}
    </div>
  );
}
