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

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-xs font-medium mb-2">Hex</label>
        <input
          type="text"
          value={bg.toUpperCase()}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setBg(v);
          }}
          className="w-full h-9 px-3 rounded-md border border-vp-border text-sm font-mono focus:outline-none focus:border-vp-blue"
        />
      </div>

      <div>
        <label className="block text-xs font-medium mb-2">Color picker</label>
        <input
          type="color"
          value={bg}
          onChange={(e) => setBg(e.target.value)}
          className="w-full h-10 rounded-md border border-vp-border cursor-pointer"
        />
      </div>

      <div>
        <label className="block text-xs font-medium mb-2">Swatches</label>
        <div className="grid grid-cols-6 gap-1.5">
          {SWATCHES.map(([color, name]) => (
            <button
              key={color}
              title={name}
              aria-label={name}
              onClick={() => setBg(color)}
              className={[
                "aspect-square rounded border-2 transition",
                bg.toLowerCase() === color.toLowerCase()
                  ? "border-vp-blue scale-110"
                  : "border-vp-border hover:border-vp-blue",
              ].join(" ")}
              style={{ background: color }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
