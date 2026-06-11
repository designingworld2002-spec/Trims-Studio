import { fabric } from "fabric";

/**
 * Undo/redo manager for fabric.js, with **rich snapshots**.
 *
 * Each entry on the stack captures not only the fabric `canvas.toJSON()`
 * payload, but also the editor's current bleed dimensions and the
 * Background-panel colour. That's load-bearing for two reasons:
 *
 *   1. Programmatic resizes (Length/Width inputs, size pills) change
 *      the bleed dimensions AND rescale every user object. If we only
 *      stored the fabric JSON, undoing a resize would restore the
 *      object positions valid for the previous size — but the bleed
 *      rectangle would still be at the post-resize size, leaving
 *      content floating relative to a wrong-sized card.
 *
 *   2. Background colour changes mutate the bleed rect's `fill`, but
 *      the bleed rect itself is `excludeFromExport` so it never appears
 *      in `canvas.toJSON()`. Without the colour in the snapshot, undoing
 *      a colour change would have nothing to restore from.
 *
 * Programmatic actions that want to commit a snapshot manually call
 * `history.commit()` from `lib/historyAccessor`.
 *
 * Events from `excludeFromExport` objects (guides, smart-alignment
 * lines) are filtered out so they never push no-op snapshots.
 */

interface HistorySnapshot {
  /** `canvas.toJSON([...whitelist])` output, JSON-stringified. */
  fabric: string;
  lengthMm: number;
  widthMm: number;
  backgroundColor: string;
}

export interface HistoryStoreAccess {
  getDims: () => { lengthMm: number; widthMm: number };
  getBackgroundColor: () => string;
  /** Set bleed dimensions WITHOUT triggering the auto-rescale (we use
   *  the snapshot's stored object positions instead). */
  setDimsForRestore: (lengthMm: number, widthMm: number) => void;
  setBackgroundColorForRestore: (c: string) => void;
}

interface HistoryManagerOptions {
  canvas: fabric.Canvas;
  virtualSize: number;
  store: HistoryStoreAccess;
  onChange: (mgr: HistoryManager) => void;
}

const TOJSON_WHITELIST = [
  "id",
  "selectable",
  "evented",
  "excludeFromExport",
  "qrUrl",
  "qrFgColor",
  "qrBgColor",
];

export class HistoryManager {
  private canvas: fabric.Canvas;
  private virtualSize: number;
  private store: HistoryStoreAccess;
  private undoStack: HistorySnapshot[] = [];
  private redoStack: HistorySnapshot[] = [];
  private restoring = false;
  private paused = false;
  private readonly onChange: (mgr: HistoryManager) => void;

  constructor(opts: HistoryManagerOptions) {
    this.canvas = opts.canvas;
    this.virtualSize = opts.virtualSize;
    this.store = opts.store;
    this.onChange = opts.onChange;
    this.attach();
  }

  /**
   * Capture the current canvas + editor state. Called from event
   * listeners and from `commit()`.
   */
  private snapshot = () => {
    if (this.restoring || this.paused) return;
    let fabricJson: string;
    try {
      fabricJson = JSON.stringify(this.canvas.toJSON(TOJSON_WHITELIST));
    } catch (e) {
      // Defensive: malformed objects (e.g. IText with `styles: undefined`
      // from third-party templates) can crash fabric's serializer. Skip
      // the snapshot rather than letting the error bubble through React.
      console.warn("[history] snapshot serialization failed:", e);
      return;
    }
    const dims = this.store.getDims();
    const entry: HistorySnapshot = {
      fabric: fabricJson,
      lengthMm: dims.lengthMm,
      widthMm: dims.widthMm,
      backgroundColor: this.store.getBackgroundColor(),
    };

    // De-dupe consecutive identical snapshots (cheap perf win and
    // prevents the stack from filling up if multiple programmatic
    // actions all commit the same state).
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      top &&
      top.fabric === entry.fabric &&
      top.lengthMm === entry.lengthMm &&
      top.widthMm === entry.widthMm &&
      top.backgroundColor === entry.backgroundColor
    ) {
      return;
    }

    this.undoStack.push(entry);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.onChange(this);
  };

  /** Public force-commit hook for programmatic actions. */
  commit() {
    this.snapshot();
  }

  /**
   * Suspend history snapshots. Use around bulk operations like
   * `loadFromJSON` where many `object:added` events would fire and the
   * partially-hydrated state is not a useful undo target.
   */
  pause() {
    this.paused = true;
  }

  resume(takeSnapshot = true) {
    this.paused = false;
    if (takeSnapshot) this.snapshot();
  }

  isPaused() {
    return this.paused;
  }

  /**
   * Filter the event-driven snapshot trigger so any object flagged
   * `excludeFromExport` (guides, smart-alignment lines) doesn't pollute
   * the undo stack with no-op snapshots.
   */
  private maybeSnapshot = (e: { target?: fabric.Object }) => {
    if (e.target && (e.target as any).excludeFromExport) return;
    this.snapshot();
  };

  private attach() {
    this.canvas.on("object:added", this.maybeSnapshot);
    this.canvas.on("object:modified", this.maybeSnapshot);
    this.canvas.on("object:removed", this.maybeSnapshot);
    // Initial blank state.
    this.snapshot();
  }

  canUndo() {
    return this.undoStack.length > 1;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.canUndo()) return;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    const prev = this.undoStack[this.undoStack.length - 1];
    this.restore(prev);
  }

  redo() {
    if (!this.canRedo()) return;
    const next = this.redoStack.pop()!;
    this.undoStack.push(next);
    this.restore(next);
  }

  /**
   * Apply a snapshot back to the canvas + store.
   *
   * Order matters:
   *  1. Restore the bleed dimensions + bg colour in the store so the
   *     Workspace's dim-change effect (and any subscribed component)
   *     re-renders to the restored size first.
   *  2. `loadFromJSON` then places objects at coordinates that are
   *     valid for the restored bleed.
   *  3. Reset canvas-level surface state (size, backgroundColor,
   *     viewportTransform) — fabric's loadFromJSON may have mutated
   *     these if the saved JSON carried them.
   */
  private restore(snap: HistorySnapshot) {
    this.restoring = true;
    this.store.setDimsForRestore(snap.lengthMm, snap.widthMm);
    this.store.setBackgroundColorForRestore(snap.backgroundColor);
    this.canvas.loadFromJSON(JSON.parse(snap.fabric), () => {
      if (
        this.canvas.width !== this.virtualSize ||
        this.canvas.height !== this.virtualSize
      ) {
        this.canvas.setDimensions({
          width: this.virtualSize,
          height: this.virtualSize,
        });
      }
      this.canvas.backgroundColor = "transparent";
      this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      this.canvas.renderAll();
      this.restoring = false;
      this.onChange(this);
    });
  }

  dispose() {
    this.canvas.off("object:added", this.maybeSnapshot as any);
    this.canvas.off("object:modified", this.maybeSnapshot as any);
    this.canvas.off("object:removed", this.maybeSnapshot as any);
  }
}
