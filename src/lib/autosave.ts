import type { fabric } from "fabric";

/**
 * Debounced auto-save manager for the fabric canvas.
 *
 * Strategy: every meaningful canvas mutation schedules a save 800ms in the
 * future. If another mutation arrives in that window, the timer resets so we
 * never thrash localStorage during a drag.
 *
 * Persistence is currently localStorage-only — in production this would POST
 * to a Shopify backend. The contract is intentionally minimal so we can swap
 * the transport later.
 */

const STORAGE_PREFIX = "trims:design:";
const DEBOUNCE_MS = 800;

export interface SavedDesign {
  workId: string;
  updatedAt: number;
  lengthMm: number;
  widthMm: number;
  productSlug: string | null;
  fabric: any;
}

export class Autosave {
  private canvas: fabric.Canvas;
  private workId: string;
  private timer: number | null = null;
  private getMeta: () => {
    lengthMm: number;
    widthMm: number;
    productSlug: string | null;
  };
  private onSaved: (id: string) => void;
  private disposed = false;

  constructor(opts: {
    canvas: fabric.Canvas;
    initialWorkId: string | null;
    getMeta: Autosave["getMeta"];
    onSaved: (workId: string) => void;
  }) {
    this.canvas = opts.canvas;
    this.workId = opts.initialWorkId ?? generateWorkId();
    this.getMeta = opts.getMeta;
    this.onSaved = opts.onSaved;
    this.attach();
  }

  private attach() {
    const schedule = () => this.scheduleSave();
    this.canvas.on("object:added", schedule);
    this.canvas.on("object:modified", schedule);
    this.canvas.on("object:removed", schedule);
  }

  private scheduleSave() {
    if (this.disposed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  /** Force an immediate save (e.g. before navigating away). */
  flush() {
    if (this.disposed) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    let payload: any;
    try {
      payload = this.canvas.toJSON([
        "id",
        "selectable",
        "evented",
        "excludeFromExport",
        "qrUrl",
        "qrFgColor",
        "qrBgColor",
      ]);
    } catch (e) {
      // Same defensive guard as HistoryManager — broken third-party objects
      // shouldn't blow up the save loop.
      console.warn("[autosave] canvas.toJSON failed, skipping save:", e);
      return;
    }
    const meta = this.getMeta();
    const record: SavedDesign = {
      workId: this.workId,
      updatedAt: Date.now(),
      lengthMm: meta.lengthMm,
      widthMm: meta.widthMm,
      productSlug: meta.productSlug,
      fabric: payload,
    };
    try {
      localStorage.setItem(STORAGE_PREFIX + this.workId, JSON.stringify(record));
      this.onSaved(this.workId);
    } catch (e) {
      console.warn("[autosave] localStorage write failed:", e);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export function loadSavedDesign(workId: string): SavedDesign | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + workId);
    return raw ? (JSON.parse(raw) as SavedDesign) : null;
  } catch {
    return null;
  }
}

export function generateWorkId(): string {
  // Short, URL-safe, time-prefixed so listings sort sensibly.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `w_${t}_${r}`;
}

/** Push `?workId=…` into the address bar without triggering a navigation. */
export function syncWorkIdToUrl(workId: string) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("workId") === workId) return;
  url.searchParams.set("workId", workId);
  window.history.replaceState(window.history.state, "", url.toString());
}
