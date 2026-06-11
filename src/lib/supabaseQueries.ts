import { getSupabase, SUPABASE_DESIGNS_BUCKET } from "./supabase";

/**
 * Read-side Supabase helpers used by the "Recent designs" + "Your uploads"
 * UI. Every function gracefully short-circuits when Supabase isn't
 * configured or the user is anonymous — callers can render an empty list
 * without checking.
 */

const ASSETS_BUCKET =
  (import.meta.env.VITE_SUPABASE_ASSETS_BUCKET as string | undefined) ??
  "design-assets";

export interface RecentDesign {
  id: string;
  created_at: string;
  product_title: string | null;
  product_slug: string | null;
  length_mm: number;
  width_mm: number;
  preview_url: string | null;
  /** Path to the preview PNG inside the storage bucket — needed to
   *  clean up the file on delete. */
  preview_path: string | null;
  fabric_json: any;
  // ---- Optional 2-sided columns (added 2026) -----------------------
  // Older rows / schemas may not carry these — every consumer must
  // tolerate `undefined` / `null`.
  fabric_json_back?: any | null;
  preview_url_back?: string | null;
  preview_path_back?: string | null;
  /** Arbitrary persistence bag — see the meta shape used by
   *  saveDesign.ts. Contains per-side metadata, canvasShape,
   *  shapeModifiers, activeSide, etc. */
  meta?: Record<string, any> | null;
}

/** Columns selected by every recent-design read. Lists the two-sided
 *  columns explicitly — PostgREST tolerates absent columns gracefully
 *  by returning them as `undefined`, so older schemas keep working. */
const RECENT_DESIGN_COLUMNS =
  "id, created_at, product_title, product_slug, length_mm, width_mm, " +
  "preview_url, preview_path, fabric_json, " +
  "fabric_json_back, preview_url_back, preview_path_back, meta";

export async function fetchRecentDesigns(
  customerId: string | null,
  limit = 12
): Promise<RecentDesign[]> {
  const supabase = getSupabase();
  if (!supabase || !customerId) return [];
  let { data, error } = await supabase
    .from("user_designs")
    .select(RECENT_DESIGN_COLUMNS)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  // If the back columns don't exist in this Supabase project yet, the
  // query will 400 with a "column does not exist" error. Fall back to
  // the legacy column set — the row data still loads, just without the
  // dedicated back columns (their content survives inside `meta`).
  if (error && /column .* does not exist|does not exist|schema cache/i.test(
    error.message || ""
  )) {
    console.warn(
      "[recent designs] back columns missing; falling back to legacy select"
    );
    const legacy = await supabase
      .from("user_designs")
      .select(
        "id, created_at, product_title, product_slug, length_mm, width_mm, preview_url, preview_path, fabric_json, meta"
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(limit);
    // Double assertion — Supabase's strict generics fall back to
    // `GenericStringError[]` when the dynamic `RECENT_DESIGN_COLUMNS`
    // string can't be parsed at compile time. We know the runtime
    // shape matches RecentDesign[], so route through `unknown`.
    data = legacy.data as unknown as typeof data;
    error = legacy.error;
  }
  if (error) {
    console.warn("[recent designs] query failed:", error);
    return [];
  }
  return (data ?? []) as unknown as RecentDesign[];
}

export interface RecentUpload {
  /** Stable identifier inside the bucket — `customerId/uuid.ext`. */
  path: string;
  name: string;
  url: string;
  createdAt: string | null;
}

export interface FetchUploadsResult {
  uploads: RecentUpload[];
  /** Human-readable reason the fetch returned an empty list, when applicable. */
  error: string | null;
}

export async function fetchRecentUploads(
  customerId: string | null,
  limit = 60
): Promise<FetchUploadsResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { uploads: [], error: "Supabase isn't configured." };
  }
  if (!customerId) {
    return { uploads: [], error: null };
  }
  const folder = customerId;
  const { data, error } = await supabase.storage
    .from(ASSETS_BUCKET)
    .list(folder, {
      limit,
      sortBy: { column: "created_at", order: "desc" },
    });
  if (error) {
    console.warn("[recent uploads] list failed:", error);
    // The most common reason `list()` errors in production: the Storage
    // bucket has no SELECT/LIST policy for the anon role. Surface a
    // useful message so the merchant can fix it without digging through
    // the network tab.
    const msg =
      error.message?.toLowerCase().includes("policy") ||
      error.message?.toLowerCase().includes("permission")
        ? `Storage list permission missing on bucket "${ASSETS_BUCKET}". Add a SELECT policy for anon in Supabase → Storage → Policies.`
        : `Couldn't load your uploads: ${error.message ?? "unknown error"}`;
    return { uploads: [], error: msg };
  }
  const uploads = (data ?? [])
    .filter((f) => f.name && !f.name.startsWith("."))
    .map((f) => {
      const path = `${folder}/${f.name}`;
      const { data: pub } = supabase.storage
        .from(ASSETS_BUCKET)
        .getPublicUrl(path);
      return {
        path,
        name: f.name,
        url: pub?.publicUrl ?? "",
        createdAt: (f as any).created_at ?? null,
      };
    });
  return { uploads, error: null };
}

export async function uploadAsset(
  customerId: string | null,
  file: File
): Promise<RecentUpload | null> {
  const supabase = getSupabase();
  if (!supabase || !customerId) return null;
  const ext =
    file.name.includes(".") ? file.name.split(".").pop() : file.type.split("/").pop();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `${customerId}/${id}.${ext ?? "png"}`;
  const { error } = await supabase.storage
    .from(ASSETS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) {
    console.warn("[upload asset] failed:", error);
    return null;
  }
  const { data: pub } = supabase.storage.from(ASSETS_BUCKET).getPublicUrl(path);
  return {
    path,
    name: file.name,
    url: pub?.publicUrl ?? "",
    createdAt: new Date().toISOString(),
  };
}

export async function deleteAsset(path: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.storage.from(ASSETS_BUCKET).remove([path]);
  if (error) {
    console.warn("[delete asset] failed:", error);
    return false;
  }
  return true;
}

export interface DeleteDesignResult {
  ok: boolean;
  /** Human-readable reason on failure. */
  error: string | null;
}

/**
 * Permanently delete a saved design from `user_designs` AND its preview
 * PNG from `design-previews` storage. Used by the "Recent designs"
 * gallery's per-card trash button.
 *
 * IMPORTANT: Postgres+RLS will silently no-op a `delete()` when the row
 * exists but the policy denies it — the call returns `error: null` but
 * doesn't remove anything. To detect this we chain `.select()` so the
 * call returns the deleted rows; an empty array means RLS blocked it.
 *
 * The preview-image cleanup is best-effort: if storage removal fails
 * (e.g. the row was created before previews started uploading, or the
 * storage policy is missing) we still report success because the
 * customer-visible record is gone.
 */
export async function deleteDesign(
  designId: string,
  previewPath?: string | null
): Promise<DeleteDesignResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { ok: false, error: "Supabase isn't configured." };
  }

  // 1. Delete the row AND ask Supabase to return what it deleted, so an
  //    RLS-blocked delete is detectable.
  const { data, error: rowErr } = await supabase
    .from("user_designs")
    .delete()
    .eq("id", designId)
    .select("id");

  if (rowErr) {
    console.warn("[delete design] row removal failed:", rowErr);
    return {
      ok: false,
      error: `Couldn't delete: ${rowErr.message ?? "unknown error"}`,
    };
  }
  if (!data || data.length === 0) {
    // Most common cause in practice: no DELETE policy on the table.
    const msg =
      "Couldn't delete that design. Add a DELETE policy on `user_designs` " +
      "for the anon role in Supabase → Authentication → Policies.";
    console.warn("[delete design] " + msg);
    return { ok: false, error: msg };
  }

  // 2. Best-effort preview cleanup.
  if (previewPath) {
    const { error: imgErr } = await supabase.storage
      .from(SUPABASE_DESIGNS_BUCKET)
      .remove([previewPath]);
    if (imgErr) {
      console.warn(
        "[delete design] preview cleanup failed (non-fatal):",
        imgErr
      );
    }
  }
  return { ok: true, error: null };
}

/**
 * Convenience: load the JSON payload for a single saved design when only
 * the row id is known (e.g. clicking a recent-design tile).
 */
export async function fetchDesign(id: string): Promise<RecentDesign | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  let { data, error } = await supabase
    .from("user_designs")
    .select(RECENT_DESIGN_COLUMNS)
    .eq("id", id)
    .single();
  if (error && /column .* does not exist|does not exist|schema cache/i.test(
    error.message || ""
  )) {
    console.warn(
      "[fetch design] back columns missing; falling back to legacy select"
    );
    const legacy = await supabase
      .from("user_designs")
      .select(
        "id, created_at, product_title, product_slug, length_mm, width_mm, preview_url, fabric_json, meta"
      )
      .eq("id", id)
      .single();
    // Double assertion — same reason as fetchRecentDesigns above.
    data = legacy.data as unknown as typeof data;
    error = legacy.error;
  }
  if (error) {
    console.warn("[fetch design] failed:", error);
    return null;
  }
  return data as unknown as RecentDesign;
}

export { ASSETS_BUCKET, SUPABASE_DESIGNS_BUCKET };
