import { Image, Plus, Shapes, SquarePen, Type, LayoutGrid } from "lucide-react";
import { useCanvasStore, type ToolKey } from "@/store/canvasStore";

interface ToolDef {
  key: NonNullable<ToolKey>;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TOOLS: ToolDef[] = [
  { key: "product", label: "Product", icon: LayoutGrid },
  { key: "text", label: "Text", icon: Type },
  { key: "uploads", label: "Uploads", icon: Image },
  { key: "graphics", label: "Graphics", icon: Shapes },
  { key: "background", label: "Background", icon: SquarePen },
  { key: "more", label: "More", icon: Plus },
];

export function LeftToolRail() {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);

  return (
    <nav
      aria-label="Tools"
      className={[
        "shrink-0 bg-white border-vp-border flex",
        // Mobile: horizontal bottom rail, full width, scroll if needed.
        "w-full h-[64px] border-t flex-row items-center justify-around overflow-x-auto",
        // Desktop: vertical left rail, fixed width.
        "md:w-[72px] md:h-auto md:border-t-0 md:border-r md:flex-col md:items-center md:justify-start md:py-2 md:overflow-visible",
      ].join(" ")}
    >
      {TOOLS.map((t) => {
        const active = activeTool === t.key;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            onClick={() => setActiveTool(t.key)}
            aria-pressed={active}
            className={[
              "rounded-md flex flex-col items-center justify-center gap-0.5 transition-colors shrink-0",
              "w-[58px] h-[54px] md:w-[60px] md:h-[60px] md:gap-1",
              active
                ? "bg-vp-blue-light text-vp-blue"
                : "text-vp-ink/70 hover:bg-vp-rail",
            ].join(" ")}
          >
            <Icon className="w-5 h-5" />
            <span className="text-[10px] font-medium">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
