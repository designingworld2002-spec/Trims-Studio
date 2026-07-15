import { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { LeftToolRail } from "./components/LeftToolRail";
import { SidePanel } from "./components/SidePanel";
import { Workspace } from "./components/Workspace";
import { BottomBar } from "./components/BottomBar";
import { PreviewModal } from "./components/PreviewModal";
import { UploadCenterModal } from "./components/UploadCenterModal";
import { BackChooserModal } from "./components/BackChooserModal";
import { FlipPreviewModal } from "./components/FlipPreviewModal";
import { NextStepBackCheckModal } from "./components/NextStepBackCheckModal";
import { ConfirmDeleteBackModal } from "./components/ConfirmDeleteBackModal";
import { MaterialSetupModal } from "./components/MaterialSetupModal";
import { useCanvasStore } from "./store/canvasStore";
import { history } from "./lib/historyAccessor";

export default function App() {
  // URL params are read synchronously in main.tsx before render, so there's
  // nothing to seed here — App owns layout, not initialisation.

  /* Global keyboard shortcuts.
   *
   *   Ctrl/Cmd+Z          Undo
   *   Ctrl/Cmd+Shift+Z    Redo (also Ctrl/Cmd+Y)
   *   Delete / Backspace  Delete active object
   *   Ctrl/Cmd+D          Duplicate
   *   Ctrl/Cmd+C          Copy
   *   Ctrl/Cmd+V          Paste
   *   Ctrl/Cmd+]          Bring forward
   *   Ctrl/Cmd+[          Send backward
   *   Ctrl/Cmd+Shift+]    Bring to front
   *   Ctrl/Cmd+Shift+[    Send to back
   *   Arrow keys          Nudge 1 px (10 px with Shift)
   *
   * All shortcuts are suppressed while typing in an input/textarea or while
   * fabric is in inline-edit mode on an IText.
   */
  useEffect(() => {
    let clipboard: any = null;

    const isEditingObj = (canvas: ReturnType<typeof useCanvasStore.getState>["canvas"]) =>
      !!(canvas?.getActiveObject() as any)?.isEditing;

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inField) return;

      const canvas = useCanvasStore.getState().canvas;
      if (isEditingObj(canvas)) return;
      const meta = e.ctrlKey || e.metaKey;
      const key = e.key;
      const lk = key.toLowerCase();
      const obj = canvas?.getActiveObject();
      const objIsUserContent = obj && !(obj as any).excludeFromExport;

      // Undo / Redo
      if (meta && lk === "z" && !e.shiftKey) {
        e.preventDefault();
        history.undo();
        return;
      }
      if ((meta && lk === "y") || (meta && e.shiftKey && lk === "z")) {
        e.preventDefault();
        history.redo();
        return;
      }

      // Delete
      if (key === "Delete" || key === "Backspace") {
        if (canvas && objIsUserContent) {
          e.preventDefault();
          canvas.remove(obj!);
          canvas.discardActiveObject();
          canvas.requestRenderAll();
        }
        return;
      }

      // Duplicate
      if (meta && lk === "d") {
        if (canvas && objIsUserContent) {
          e.preventDefault();
          obj!.clone((clone: any) => {
            clone.set({
              left: (obj!.left ?? 0) + 20,
              top: (obj!.top ?? 0) + 20,
            });
            canvas.add(clone);
            canvas.setActiveObject(clone);
            canvas.requestRenderAll();
          });
        }
        return;
      }

      // Copy
      if (meta && lk === "c") {
        if (canvas && objIsUserContent) {
          e.preventDefault();
          obj!.clone((c: any) => {
            clipboard = c;
          });
        }
        return;
      }

      // Paste
      if (meta && lk === "v") {
        if (canvas && clipboard) {
          e.preventDefault();
          clipboard.clone((clone: any) => {
            clone.set({
              left: (clone.left ?? 0) + 20,
              top: (clone.top ?? 0) + 20,
              evented: true,
            });
            canvas.add(clone);
            canvas.setActiveObject(clone);
            canvas.requestRenderAll();
          });
        }
        return;
      }

      // Arrange
      if (meta && (key === "]" || key === "[")) {
        if (canvas && objIsUserContent) {
          e.preventDefault();
          if (key === "]") {
            e.shiftKey ? canvas.bringToFront(obj!) : canvas.bringForward(obj!);
          } else {
            e.shiftKey ? canvas.sendToBack(obj!) : canvas.sendBackwards(obj!);
          }
          canvas.requestRenderAll();
          canvas.fire("object:modified", { target: obj });
        }
        return;
      }

      // Nudge with arrow keys
      if (
        canvas &&
        objIsUserContent &&
        (key === "ArrowUp" ||
          key === "ArrowDown" ||
          key === "ArrowLeft" ||
          key === "ArrowRight")
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (key === "ArrowUp") obj!.top = (obj!.top ?? 0) - step;
        if (key === "ArrowDown") obj!.top = (obj!.top ?? 0) + step;
        if (key === "ArrowLeft") obj!.left = (obj!.left ?? 0) - step;
        if (key === "ArrowRight") obj!.left = (obj!.left ?? 0) + step;
        obj!.setCoords();
        canvas.requestRenderAll();
        canvas.fire("object:modified", { target: obj });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    /*
     * Strict app layout: the OUTER container is the only viewport. It's
     * `h-screen w-screen overflow-hidden` so the browser window itself
     * never scrolls. Every interior region (TopBar, rail, panel, main)
     * sizes itself within this fixed shell.
     *
     * `min-h-0` is intentional on the body row — without it flex children
     * default to `min-height: auto`, which prevents `overflow-hidden`
     * inside `<main>` from working.
     */
    <div className="h-screen w-screen overflow-hidden flex flex-col">
      <TopBar />
      <div className="flex-1 flex flex-col-reverse md:flex-row min-h-0 overflow-hidden">
        <LeftToolRail />
        <SidePanel />
        <main className="flex-1 relative bg-vp-rail min-w-0 min-h-0 overflow-hidden">
          <Workspace />
          <BottomBar />
        </main>
      </div>
      <PreviewModal />
      <UploadCenterModal />
      <BackChooserModal />
      <FlipPreviewModal />
      <NextStepBackCheckModal />
      <ConfirmDeleteBackModal />
      <MaterialSetupModal />
    </div>
  );
}
