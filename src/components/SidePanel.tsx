import { ChevronsLeft } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { TextPanel } from "./panels/TextPanel";
import { UploadsPanel } from "./panels/UploadsPanel";
import { BackgroundPanel } from "./panels/BackgroundPanel";
import { ProductPanel } from "./panels/ProductPanel";
import { GraphicsPanel } from "./panels/GraphicsPanel";
import { MorePanel } from "./panels/MorePanel";

/**
 * Slide-out drawer (300px) anchored to the left rail.
 * Renders nothing when no tool is active.
 */
export function SidePanel() {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);

  if (!activeTool) return null;

  const titles: Record<NonNullable<typeof activeTool>, string> = {
    product: "Product options",
    text: "Text",
    uploads: "Uploads",
    graphics: "Graphics",
    background: "Background",
    more: "More",
  };

  return (
    <aside
      className={[
        "shrink-0 bg-white flex flex-col",
        // Mobile: full-width sheet pinned above the rail.
        "w-full max-h-[55vh] border-t border-gray-200",
        // Desktop: a FLOATING card — generous margin so it sits clearly
        // detached from both the tool rail and the canvas workspace.
        "md:w-[320px] md:max-h-none md:h-[calc(100%-2rem)] md:my-4 md:ml-4",
        "md:border-t-0 md:border md:border-gray-200/80 md:rounded-2xl md:shadow-lg md:shadow-slate-900/[0.07]",
        "md:overflow-hidden",
      ].join(" ")}
      aria-label={`${titles[activeTool]} panel`}
    >
      <div className="h-14 flex items-center justify-between px-6 border-b border-gray-100 shrink-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-vp-ink">
          {titles[activeTool]}
        </h2>
        <button
          onClick={() => setActiveTool(null)}
          aria-label="Collapse panel"
          className="w-7 h-7 rounded-md hover:bg-slate-100 flex items-center justify-center transition-colors text-vp-muted hover:text-vp-ink"
        >
          <ChevronsLeft className="w-4 h-4 hidden md:block" strokeWidth={1.6} />
          {/* Mobile uses an X-style close affordance instead of a left arrow. */}
          <span className="md:hidden text-lg leading-none">×</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto vp-scroll p-6">
        {activeTool === "product" && <ProductPanel />}
        {activeTool === "text" && <TextPanel />}
        {activeTool === "uploads" && <UploadsPanel />}
        {activeTool === "background" && <BackgroundPanel />}
        {activeTool === "graphics" && <GraphicsPanel />}
        {activeTool === "more" && <MorePanel />}
      </div>
    </aside>
  );
}
