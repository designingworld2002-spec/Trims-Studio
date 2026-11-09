import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useCanvasStore, type ToolKey } from "@/store/canvasStore";
import { TextPanel } from "../panels/TextPanel";
import { UploadsPanel } from "../panels/UploadsPanel";
import { BackgroundPanel } from "../panels/BackgroundPanel";
import { ProductPanel } from "../panels/ProductPanel";
import { GraphicsPanel } from "../panels/GraphicsPanel";
import { MorePanel } from "../panels/MorePanel";

const TITLES: Record<NonNullable<ToolKey>, string> = {
  product: "Product options",
  text: "Text",
  uploads: "Images",
  graphics: "Shapes",
  background: "Background",
  more: "More",
};

/**
 * Vistaprint-style bottom sheet (mobile only).
 *
 * The same panel components the desktop `SidePanel` renders, but presented
 * as a sheet that slides up from the bottom edge with a rounded top, a
 * sticky header, a grab handle and a close affordance. Stays mounted so
 * the open/close transition animates both ways; the last-opened panel is
 * kept rendered while it slides away.
 */
export function MobileBottomSheet() {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const previewMode = useCanvasStore((s) => s.previewMode);

  // Keep the last-opened tool rendered during the slide-down so the sheet
  // never goes blank mid-animation.
  const [lastTool, setLastTool] = useState<NonNullable<ToolKey> | null>(null);
  useEffect(() => {
    if (activeTool) setLastTool(activeTool);
  }, [activeTool]);

  const open = !!activeTool && !previewMode;
  const tool = activeTool ?? lastTool;

  const close = () => setActiveTool(null);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-hidden={!open}
      aria-label={tool ? `${TITLES[tool]} panel` : undefined}
      className={[
        "md:hidden fixed bottom-0 left-0 w-full h-[55vh] max-h-[560px] z-[60] flex flex-col",
        "bg-white rounded-t-2xl shadow-[0_-10px_40px_rgba(0,0,0,0.1)]",
        "transform transition-transform duration-300 ease-out",
        open ? "translate-y-0" : "translate-y-full pointer-events-none",
      ].join(" ")}
    >
      {/* Grab handle */}
      <div className="pt-2.5 pb-1 flex justify-center shrink-0">
        <span className="h-1 w-10 rounded-full bg-slate-300" aria-hidden />
      </div>

      {/* Sticky header */}
      <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-gray-100">
        <h2 className="text-[15px] font-semibold tracking-tight text-vp-ink">
          {tool ? TITLES[tool] : ""}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close panel"
          className="w-8 h-8 -mr-1 rounded-full hover:bg-slate-100 flex items-center justify-center text-vp-muted hover:text-vp-ink transition-colors"
        >
          <ChevronDown className="w-5 h-5" strokeWidth={1.8} />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto vp-scroll p-5">
        {tool === "product" && <ProductPanel />}
        {tool === "text" && <TextPanel />}
        {tool === "uploads" && <UploadsPanel />}
        {tool === "background" && <BackgroundPanel />}
        {tool === "graphics" && <GraphicsPanel />}
        {tool === "more" && <MorePanel />}
      </div>
    </div>
  );
}
