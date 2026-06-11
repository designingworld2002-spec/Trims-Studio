import { Image, Plus, Shapes, SquarePen, Type, LayoutGrid } from "lucide-react";
import { useCanvasStore, type ToolKey } from "@/store/canvasStore";

interface ToolDef {
  key: NonNullable<ToolKey>;
  label: string;
  icon: React.ComponentType<{
    className?: string;
    strokeWidth?: number | string;
  }>;
}

const TOOLS: ToolDef[] = [
  { key: "product", label: "Product", icon: LayoutGrid },
  { key: "text", label: "Text", icon: Type },
  { key: "uploads", label: "Uploads", icon: Image },
  { key: "graphics", label: "Graphics", icon: Shapes },
  { key: "background", label: "Background", icon: SquarePen },
  { key: "more", label: "More", icon: Plus },
];

// Thin stroke for the modern, minimal Vistaprint feel.
const ICON_STROKE = 1.6;

export function LeftToolRail() {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const allowedTools = useCanvasStore((s) => s.productConfig.allowedTools);
  const visibleTools = TOOLS.filter((t) => allowedTools.includes(t.key));

  return (
    <nav
      aria-label="Tools"
      className={[
        "shrink-0 bg-white flex",
        // Mobile: horizontal bottom rail.
        "w-full h-[64px] border-t border-gray-200 flex-row items-center justify-around overflow-x-auto px-1",
        // Desktop: clean white vertical column with right hairline.
        "md:w-[80px] md:h-auto md:border-t-0 md:border-r md:flex-col md:items-stretch md:justify-start md:py-3 md:px-0 md:gap-0.5 md:overflow-visible",
      ].join(" ")}
    >
      {visibleTools.map((t) => {
        const active = activeTool === t.key;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            onClick={() => setActiveTool(t.key)}
            aria-pressed={active}
            title={t.label}
            className={[
              "relative group flex flex-col items-center justify-center transition-colors shrink-0 outline-none",
              // Mobile: pill button.
              "w-[58px] h-[54px] rounded-lg gap-0.5",
              // Desktop: full-width tile, no rounded background — the
              // left-border accent does the work.
              "md:w-full md:h-[72px] md:rounded-none md:gap-1.5",
              active
                ? "text-vp-accent"
                : "text-slate-500 hover:text-vp-ink",
              // Soft hover wash on mobile, nothing on desktop.
              !active && "hover:bg-slate-50 md:hover:bg-transparent",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {/* Active indicator — 2px dark-slate left border on desktop,
                small top bar on mobile. No filled chip. */}
            {active && (
              <>
                <span
                  aria-hidden
                  className="hidden md:block absolute left-0 top-0 bottom-0 w-[2px] bg-vp-accent"
                />
                <span
                  aria-hidden
                  className="md:hidden absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-b-full bg-vp-accent"
                />
              </>
            )}
            <Icon
              className="w-[22px] h-[22px] transition-transform group-hover:scale-105"
              strokeWidth={ICON_STROKE}
            />
            <span className="text-[10.5px] font-medium tracking-wide leading-none">
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
