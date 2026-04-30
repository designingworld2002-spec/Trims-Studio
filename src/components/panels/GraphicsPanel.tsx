import { useState } from "react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE, MM_TO_PX } from "../Workspace";

/* ------------------------------------------------------------------ */
/* Shape catalog                                                       */
/* ------------------------------------------------------------------ */

type ShapeFactory = (size: number) => fabric.Object;

interface ShapeDef {
  key: string;
  label: string;
  factory: ShapeFactory;
  /** Inline SVG used to render the picker thumbnail. */
  preview: string;
}

const stroke = "#0a1f44";
const STROKE_W = 3;

/** Build solid + hollow variants of the same outline so the catalog has both. */
function solidAndHollow(
  key: string,
  label: string,
  previewSvg: (mode: "solid" | "hollow") => string,
  buildFilled: (size: number) => fabric.Object
): ShapeDef[] {
  return [
    {
      key,
      label,
      preview: previewSvg("solid"),
      factory: buildFilled,
    },
    {
      key: `${key}-outline`,
      label: `${label} (outline)`,
      preview: previewSvg("hollow"),
      factory: (s) => {
        const o = buildFilled(s);
        o.set({
          fill: "transparent",
          stroke,
          strokeWidth: STROKE_W,
          strokeUniform: true,
        });
        return o;
      },
    },
  ];
}

const SHAPES: ShapeDef[] = [
  ...solidAndHollow(
    "rect",
    "Rectangle",
    (m) =>
      m === "solid"
        ? '<rect x="6" y="10" width="36" height="28" rx="2" fill="#0a1f44"/>'
        : '<rect x="6" y="10" width="36" height="28" rx="2" fill="none" stroke="#0a1f44" stroke-width="3"/>',
    (s) => new fabric.Rect({ width: s, height: s * 0.7, fill: stroke, rx: 4, ry: 4 })
  ),
  ...solidAndHollow(
    "circle",
    "Circle",
    (m) =>
      m === "solid"
        ? '<circle cx="24" cy="24" r="14" fill="#0a1f44"/>'
        : '<circle cx="24" cy="24" r="14" fill="none" stroke="#0a1f44" stroke-width="3"/>',
    (s) => new fabric.Circle({ radius: s / 2, fill: stroke })
  ),
  ...solidAndHollow(
    "triangle",
    "Triangle",
    (m) =>
      m === "solid"
        ? '<polygon points="24,8 40,40 8,40" fill="#0a1f44"/>'
        : '<polygon points="24,8 40,40 8,40" fill="none" stroke="#0a1f44" stroke-width="3"/>',
    (s) => new fabric.Triangle({ width: s, height: s, fill: stroke })
  ),
  {
    key: "line",
    label: "Line",
    preview:
      '<line x1="6" y1="24" x2="42" y2="24" stroke="#0a1f44" stroke-width="3" stroke-linecap="round"/>',
    factory: (s) =>
      new fabric.Line([0, 0, s, 0], {
        stroke,
        strokeWidth: 4,
        strokeLineCap: "round",
      }),
  },
  ...solidAndHollow(
    "star",
    "Star",
    (m) =>
      m === "solid"
        ? '<polygon fill="#0a1f44" points="24,6 29,18 42,19 32,28 35,40 24,33 13,40 16,28 6,19 19,18"/>'
        : '<polygon fill="none" stroke="#0a1f44" stroke-width="3" stroke-linejoin="round" points="24,6 29,18 42,19 32,28 35,40 24,33 13,40 16,28 6,19 19,18"/>',
    (s) => starPolygon(s, 5, 0.45)
  ),
  ...solidAndHollow(
    "hexagon",
    "Hexagon",
    (m) =>
      m === "solid"
        ? '<polygon fill="#0a1f44" points="24,6 40,15 40,33 24,42 8,33 8,15"/>'
        : '<polygon fill="none" stroke="#0a1f44" stroke-width="3" stroke-linejoin="round" points="24,6 40,15 40,33 24,42 8,33 8,15"/>',
    (s) => regularPolygon(s / 2, 6)
  ),
  ...solidAndHollow(
    "heart",
    "Heart",
    (m) =>
      m === "solid"
        ? '<path fill="#0a1f44" d="M24 41 C 8 30, 4 22, 4 16 a8 8 0 0 1 16 -2 a8 8 0 0 1 16 2 c 0 6 -4 14 -20 25 z"/>'
        : '<path fill="none" stroke="#0a1f44" stroke-width="3" stroke-linejoin="round" d="M24 41 C 8 30, 4 22, 4 16 a8 8 0 0 1 16 -2 a8 8 0 0 1 16 2 c 0 6 -4 14 -20 25 z"/>',
    () =>
      new fabric.Path(
        "M 0 6 C -16 -5 -20 -13 -20 -19 a 8 8 0 0 1 16 -2 a 8 8 0 0 1 16 2 c 0 6 -4 14 -20 25 z",
        { fill: stroke, originX: "center", originY: "center" }
      )
  ),
  ...solidAndHollow(
    "arrow",
    "Arrow",
    (m) =>
      m === "solid"
        ? '<path fill="#0a1f44" d="M6 20h22v-8l14 12-14 12v-8H6z"/>'
        : '<path fill="none" stroke="#0a1f44" stroke-width="3" stroke-linejoin="round" d="M6 20h22v-8l14 12-14 12v-8H6z"/>',
    () =>
      new fabric.Path(
        "M 0 -10 H 22 V -18 L 36 0 L 22 18 V 10 H 0 Z",
        { fill: stroke, originX: "center", originY: "center" }
      )
  ),
];

/* helpers ---------------------------------------------------------- */

function starPolygon(size: number, points: number, innerRatio: number) {
  const cx = 0;
  const cy = 0;
  const outer = size / 2;
  const inner = outer * innerRatio;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / points) * i - Math.PI / 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return new fabric.Polygon(pts, {
    fill: stroke,
    originX: "center",
    originY: "center",
  });
}

function regularPolygon(radius: number, sides: number) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides - Math.PI / 2;
    pts.push({ x: radius * Math.cos(a), y: radius * Math.sin(a) });
  }
  return new fabric.Polygon(pts, {
    fill: stroke,
    originX: "center",
    originY: "center",
  });
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const TABS = ["Shapes", "Images", "Icons", "Illustrations"] as const;
type TabKey = (typeof TABS)[number];

export function GraphicsPanel() {
  const [tab, setTab] = useState<TabKey>("Shapes");
  const [query, setQuery] = useState("");
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);

  const addShape = (def: ShapeDef) => {
    if (!canvas) return;
    // Default footprint: ~25% of the smaller trim dimension.
    const target = Math.min(lengthMm, widthMm) * MM_TO_PX * 0.25;
    const obj = def.factory(target);
    obj.set({
      left: VIRTUAL_SIZE / 2,
      top: VIRTUAL_SIZE / 2,
      originX: "center",
      originY: "center",
    });
    canvas.add(obj);
    canvas.setActiveObject(obj);
    canvas.requestRenderAll();
  };

  const filtered = SHAPES.filter(
    (s) => !query || s.label.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="space-y-3">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for content"
        className="w-full h-9 px-3 rounded-md border border-vp-border text-sm focus:outline-none focus:border-vp-blue"
      />

      <div className="flex gap-1 border-b border-vp-border -mx-1 px-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "h-8 px-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              tab === t
                ? "border-vp-blue text-vp-blue"
                : "border-transparent text-vp-muted hover:text-vp-ink",
            ].join(" ")}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Shapes" ? (
        <div className="grid grid-cols-3 gap-2">
          {filtered.map((s) => (
            <button
              key={s.key}
              title={s.label}
              aria-label={s.label}
              onClick={() => addShape(s)}
              className="aspect-square rounded border border-vp-border hover:border-vp-blue bg-white flex items-center justify-center"
            >
              <svg
                viewBox="0 0 48 48"
                className="w-10 h-10"
                dangerouslySetInnerHTML={{ __html: s.preview }}
              />
            </button>
          ))}
        </div>
      ) : (
        <div className="text-xs text-vp-muted text-center pt-8">
          {tab} library coming soon — currently only Shapes are stocked.
        </div>
      )}
    </div>
  );
}
