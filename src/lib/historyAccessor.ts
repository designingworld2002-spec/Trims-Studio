import type { HistoryManager } from "./history";

/**
 * Module-scoped facade for the HistoryManager.
 *
 * The actual `HistoryManager` is owned by Workspace.tsx (it's tied to
 * the fabric canvas lifecycle), but consumers from anywhere in the app
 * — the TopBar's Undo/Redo buttons, keyboard shortcuts, `canvasStore`
 * actions that need to commit a snapshot after a programmatic edit —
 * need a stable, import-friendly way to call into it.
 *
 * Workspace registers / unregisters the instance via `_registerHistory`.
 * Everything else just reads from `history`.
 *
 * Living in its own file means `canvasStore` can `import` it without
 * pulling in Workspace (which would create a circular dependency).
 */

let _historyManager: HistoryManager | null = null;

export function _registerHistory(h: HistoryManager | null) {
  _historyManager = h;
}

export const history = {
  undo: () => _historyManager?.undo(),
  redo: () => _historyManager?.redo(),
  /**
   * Force an explicit snapshot. Use this from programmatic actions that
   * fabric doesn't auto-track via object:added / modified / removed —
   * e.g. dimension changes (which rescale objects but don't fire those
   * events) and background-colour changes (which mutate the bleed rect
   * but the bleed is `excludeFromExport`, so our maybeSnapshot filter
   * deliberately ignores its modify events).
   */
  commit: () => _historyManager?.commit(),
  isPaused: () => _historyManager?.isPaused() ?? false,
  pause: () => _historyManager?.pause(),
  resume: (takeSnapshot = true) => _historyManager?.resume(takeSnapshot),
};
