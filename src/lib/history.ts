import { fabric } from "fabric";

/**
 * A small undo/redo manager for fabric.js.
 *
 * Strategy: snapshot the canvas as JSON after every "object:modified",
 * "object:added", "object:removed". On undo/redo we set a `restoring`
 * flag so the snapshot listener doesn't re-record the restoration step.
 *
 * We exclude any object whose `excludeFromExport` is true (our guides) so
 * the history only tracks user content.
 */
export class HistoryManager {
  private canvas: fabric.Canvas;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private restoring = false;
  private paused = false;
  private readonly onChange: (mgr: HistoryManager) => void;

  constructor(
    canvas: fabric.Canvas,
    onChange: (mgr: HistoryManager) => void
  ) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.attach();
  }

  private snapshot = () => {
    if (this.restoring || this.paused) return;
    let json: string;
    try {
      json = JSON.stringify(
        this.canvas.toJSON(["id", "selectable", "evented", "excludeFromExport"])
      );
    } catch (e) {
      // Defensive: malformed objects (e.g. IText with `styles: undefined`
      // from third-party templates) can crash fabric's serializer. Skip the
      // snapshot rather than letting the error bubble through React.
      console.warn("[history] snapshot serialization failed:", e);
      return;
    }
    this.undoStack.push(json);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.onChange(this);
  };

  /**
   * Suspend history snapshots. Use around bulk operations like
   * `loadFromJSON` where many `object:added` events would fire and where
   * the partially-hydrated state is not a useful undo target anyway.
   */
  pause() {
    this.paused = true;
  }

  resume(takeSnapshot = true) {
    this.paused = false;
    if (takeSnapshot) this.snapshot();
  }

  private attach() {
    this.canvas.on("object:added", this.snapshot);
    this.canvas.on("object:modified", this.snapshot);
    this.canvas.on("object:removed", this.snapshot);
    // Initial blank state:
    this.snapshot();
  }

  canUndo() {
    // we keep at least 1 snapshot (the current state); undo needs ≥ 2.
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

  private restore(json: string) {
    this.restoring = true;
    this.canvas.loadFromJSON(json, () => {
      this.canvas.renderAll();
      this.restoring = false;
      this.onChange(this);
    });
  }

  dispose() {
    this.canvas.off("object:added", this.snapshot as any);
    this.canvas.off("object:modified", this.snapshot as any);
    this.canvas.off("object:removed", this.snapshot as any);
  }
}
