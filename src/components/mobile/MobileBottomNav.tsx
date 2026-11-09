import { Image, Plus, Shapes, SquarePen, Type, LayoutGrid } from "lucide-react";
import { useCanvasStore, type ToolKey } from "@/store/canvasStore";

interface ToolDef {
  key: NonNullable<ToolKey>;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
}

// Mobile labels follow the Vistaprint reference ("Images", "Shapes")
// rather than the desktop rail's internal naming.
const TOOLS: ToolDef[] = [
  { key: "product", label: "Product", icon: LayoutGrid },
  { key: "text", label: "Text", icon: Type },
  { key: "uploads", label: "Images", icon: Image },
  { key: "graphics", label: "Shapes", icon: Shapes },
  { key: "background", label: "Background", icon: SquarePen },
  { key: "more", label: "More", icon: Plus },
];

/**
 * Vistaprint-style fixed bottom navigation rail (mobile only).
 *
 * A horizontally scrollable row of icon + label buttons mapping the
 * product's global tools. Hidden on desktop (the vertical `LeftToolRail`
 * takes over) and while in Preview Mode.
 */
export function MobileBottomNav() {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const previewMode = useCanvasStore((s) => s.previewMode);
  const allowedTools = useCanvasStore((s) => s.productConfig.allowedTools);
  const visibleTools = TOOLS.filter((t) => allowedTools.includes(t.key));

  if (previewMode) return null;

  return (
    <nav
      aria-label="Tools"
      data-tour="sidebar"
      className="md:hidden fixed bottom-0 left-0 w-full z-50 bg-white border-t border-gray-200 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex overflow-x-auto snap-x hide-scrollbar gap-4 px-4 py-3">
        {visibleTools.map((t) => {
          const active = activeTool === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTool(t.key)}
              aria-pressed={active}
              className={[
                "snap-start shrink-0 flex flex-col items-center justify-center gap-1 text-[10px] font-medium leading-none w-14 outline-none transition-colors",
                active ? "text-vp-blue" : "text-slate-500 hover:text-slate-800",
              ].join(" ")}
            >
              <span
                className={[
                  "flex items-center justify-center w-9 h-9 rounded-full transition-colors",
                  active ? "bg-vp-blue text-white shadow-sm" : "bg-transparent text-current",
                ].join(" ")}
              >
                <Icon className="w-5 h-5" strokeWidth={active ? 2.2 : 1.6} />
              </span>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
