import { useCanvasStore } from "@/store/canvasStore";

const SWATCHES = [
  ["#ffffff", "White"],
  ["#f3f4f6", "Light gray"],
  ["#9ca3af", "Gray"],
  ["#0a1f44", "Ink"],
  ["#000000", "Black"],
  ["#fee2e2", "Blush"],
  ["#fca5a5", "Coral"],
  ["#ef4444", "Red"],
  ["#fed7aa", "Peach"],
  ["#f59e0b", "Amber"],
  ["#fef3c7", "Cream"],
  ["#fde68a", "Sun"],
  ["#dcfce7", "Mint"],
  ["#86efac", "Sage"],
  ["#22c55e", "Green"],
  ["#cffafe", "Sky"],
  ["#67e8f9", "Cyan"],
  ["#0ea5e9", "Blue"],
  ["#dbeafe", "Pale blue"],
  ["#0066ff", "Vista blue"],
  ["#1e3a8a", "Navy"],
  ["#ede9fe", "Lavender"],
  ["#a78bfa", "Violet"],
  ["#7c3aed", "Purple"],
];

export function BackgroundPanel() {
  const bg = useCanvasStore((s) => s.backgroundColor);
  const setBg = useCanvasStore((s) => s.setBackgroundColor);
  const recents = useCanvasStore((s) => s.recentColors);
  const addRecent = useCanvasStore((s) => s.addRecentColor);

  const apply = (c: string) => {
    setBg(c);
    addRecent(c);
  };

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Hex</SectionLabel>
        <input
          type="text"
          value={bg.toUpperCase()}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setBg(v);
          }}
          onBlur={() => addRecent(bg)}
          className="w-full h-10 px-3.5 rounded-lg border border-vp-border text-sm font-mono tracking-wide focus:outline-none focus:border-vp-blue focus:ring-2 focus:ring-vp-blue/15 transition"
        />
      </div>

      <div>
        <SectionLabel>Color picker</SectionLabel>
        <input
          type="color"
          value={bg.startsWith("#") ? bg : "#ffffff"}
          onChange={(e) => setBg(e.target.value)}
          onBlur={() => addRecent(bg)}
          className="w-full h-11 rounded-lg border border-vp-border cursor-pointer hover:border-vp-blue/50 transition"
        />
      </div>

      {recents.length > 0 && (
        <div>
          <SectionLabel>Recent colors</SectionLabel>
          <div className="grid grid-cols-8 gap-1.5">
            {recents.map((c) => (
              <button
                key={c}
                title={c.toUpperCase()}
                onClick={() => setBg(c)}
                className={[
                  "aspect-square rounded-md ring-1 transition-all duration-150",
                  bg.toLowerCase() === c.toLowerCase()
                    ? "ring-2 ring-vp-blue scale-110 shadow-sm"
                    : "ring-vp-border hover:ring-vp-blue/60 hover:scale-105",
                ].join(" ")}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Swatches</SectionLabel>
        <div className="grid grid-cols-6 gap-1.5">
          {SWATCHES.map(([color, name]) => (
            <button
              key={color}
              title={name}
              aria-label={name}
              onClick={() => apply(color)}
              className={[
                "aspect-square rounded-md ring-1 transition-all duration-150",
                bg.toLowerCase() === color.toLowerCase()
                  ? "ring-2 ring-vp-blue scale-110 shadow-sm"
                  : "ring-vp-border hover:ring-vp-blue/60 hover:scale-105",
              ].join(" ")}
              style={{ background: color }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 mb-2.5">
      {children}
    </label>
  );
}
