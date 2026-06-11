import { useCanvasStore } from "@/store/canvasStore";

/**
 * Floating Front / Back thumbnail switcher pinned bottom-right of the
 * workspace, mirroring the Vistaprint editor. Renders only for products
 * with `supportsBackSide: true`. Suppressed in Preview Mode.
 */
export function SideToggle() {
  const supportsBack = useCanvasStore(
    (s) => s.productConfig.supportsBackSide
  );
  const activeSide = useCanvasStore((s) => s.activeSide);
  const setActiveSide = useCanvasStore((s) => s.setActiveSide);
  const previewMode = useCanvasStore((s) => s.previewMode);
  const backDesign = useCanvasStore((s) => s.backDesign);
  const setBackChooserOpen = useCanvasStore((s) => s.setBackChooserOpen);

  if (!supportsBack || previewMode) return null;

  const sides: { key: "front" | "back"; label: string }[] = [
    { key: "front", label: "Front" },
    { key: "back", label: "Back" },
  ];

  const onPick = (side: "front" | "back") => {
    // First-time Back: pop the chooser modal instead of jumping straight
    // to a blank canvas. Once backDesign exists, the click switches
    // instantly (like Vistaprint after the back has been started).
    if (side === "back" && activeSide !== "back" && !backDesign) {
      setBackChooserOpen(true);
      return;
    }
    setActiveSide(side);
  };

  return (
    <div
      className="absolute right-6 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-4 bg-white/95 backdrop-blur-sm border border-vp-border rounded-xl shadow-vp-pop p-2"
      aria-label="Switch side"
    >
      {sides.map((s) => {
        const active = activeSide === s.key;
        return (
          <button
            key={s.key}
            onClick={() => onPick(s.key)}
            aria-pressed={active}
            className={[
              "flex flex-col items-center gap-1.5 px-3 py-2 rounded-lg transition-all",
              active
                ? "bg-vp-accent text-white"
                : "text-vp-ink/70 hover:bg-vp-rail",
            ].join(" ")}
          >
            <div
              className={[
                "w-16 h-10 rounded border flex items-center justify-center text-[11px] font-semibold tracking-wide",
                active
                  ? "border-white/40 bg-white/15"
                  : "border-vp-border bg-white",
              ].join(" ")}
            >
              {s.key === "front" ? "F" : "B"}
            </div>
            <span className="text-[11px] font-medium leading-none">
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
