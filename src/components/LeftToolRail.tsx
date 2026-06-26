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
        // Mobile: horizontal bottom rail — keep the hairline so it
        // separates from the canvas.
        "w-full h-[64px] border-t border-gray-100 flex-row items-center justify-around overflow-x-auto px-1",
        // Desktop: clean white vertical column, NO right border. The
        // canvas already sits on a soft tinted background which gives
        // the natural separation, and dropping the border matches the
        // reference's flat look.
        "md:w-[80px] md:h-auto md:border-t-0 md:border-r-0 md:flex-col md:items-stretch md:justify-start md:py-3 md:px-0 md:gap-1.5 md:overflow-visible",
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
              "w-[58px] h-[54px] rounded-lg gap-1",
              // Desktop: full-width tile, no chip — the blue-circle
              // icon below provides the active state on its own.
              "md:w-full md:h-[72px] md:rounded-none md:gap-1.5",
              active
                ? "text-sky-500"
                : "text-slate-500 hover:text-slate-800",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {/* Icon — wrapped in a soft chip that turns into a solid
                sky-400 circle when the tool is active. White icon on
                blue chip mirrors the reference's flat UI. */}
            <span
              aria-hidden
              className={[
                "flex items-center justify-center transition-colors",
                "w-9 h-9 rounded-full",
                active
                  ? "bg-vp-blue text-white shadow-sm"
                  : "bg-transparent text-current",
              ].join(" ")}
            >
              <Icon
                className="w-[20px] h-[20px] transition-transform group-hover:scale-105"
                strokeWidth={active ? 2.2 : ICON_STROKE}
              />
            </span>
            <span
              className={[
                "text-[10.5px] font-medium tracking-wide leading-none",
                active ? "text-sky-500" : "text-slate-500",
              ].join(" ")}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
