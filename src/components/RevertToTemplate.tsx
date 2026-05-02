import { RotateCcw } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";

/**
 * Pill that appears at the top of the canvas after the user loads a
 * design from the "Recent designs" picker. Clicking it reloads the page
 * with the original boot URL (the storefront-supplied template/upload
 * link), so the user can get back to the template they started from
 * without losing their place.
 */
export function RevertToTemplate() {
  const isRecent = useCanvasStore((s) => s.isRecentDesignLoaded);
  const original = useCanvasStore((s) => s.originalUrlSearch);

  if (!isRecent) return null;

  const onRevert = () => {
    if (
      window.confirm(
        "Discard the loaded design and return to the original template?"
      )
    ) {
      // Use a full reload so every part of the editor (history, autosave,
      // store) re-initialises cleanly from the original URL.
      window.location.search = original || "";
    }
  };

  return (
    <button
      onClick={onRevert}
      className="absolute top-3 right-3 z-20 h-8 px-3 rounded-full bg-white border border-vp-border shadow-vp-card text-xs font-medium hover:border-vp-blue hover:text-vp-blue flex items-center gap-1.5"
    >
      <RotateCcw className="w-3.5 h-3.5" />
      Revert to original template
    </button>
  );
}
