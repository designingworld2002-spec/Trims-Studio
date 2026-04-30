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
        "shrink-0 bg-white border-vp-border flex flex-col",
        // Mobile: full-width sheet pinned above the rail.
        "w-full max-h-[55vh] border-t",
        // Desktop: 300px fixed sidebar.
        "md:w-[300px] md:max-h-none md:h-auto md:border-t-0 md:border-r",
      ].join(" ")}
      aria-label={`${titles[activeTool]} panel`}
    >
      <div className="h-12 flex items-center justify-between px-4 border-b border-vp-border shrink-0">
        <h2 className="text-sm font-semibold">{titles[activeTool]}</h2>
        <button
          onClick={() => setActiveTool(null)}
          aria-label="Collapse panel"
          className="w-7 h-7 rounded hover:bg-vp-rail flex items-center justify-center"
        >
          <ChevronsLeft className="w-4 h-4 hidden md:block" />
          {/* Mobile uses an X-style close affordance instead of a left arrow. */}
          <span className="md:hidden text-lg leading-none">×</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto vp-scroll p-4">
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
