import { X } from "lucide-react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { MM_TO_PX } from "./Workspace";

/**
 * Washcare Signs library — a comprehensive, professional set of the
 * international garment-care symbols, grouped into the five standard
 * categories (Washing, Bleaching, Drying, Ironing, Dry Cleaning).
 *
 * Every symbol is a "lining" (stroke-based) icon: the artwork uses
 * `fill="none" stroke="currentColor" stroke-width="6"` in a 0–100 viewBox
 * so it reads as a clean outline. `currentColor` lets the modal preview
 * pick up the surrounding CSS colour; when the icon is dropped on the
 * canvas we swap `currentColor` for a concrete ink colour and parse the
 * raw SVG with `fabric.loadSVGFromString`, grouping the parsed elements
 * with `fabric.util.groupSVGElements`. The result is a `fabric.Group`
 * (or a single object for one-shape symbols) that:
 *   - classifies as a "shape"/"group" → drives the Contextual Toolbar, and
 *   - recolours correctly: `patchActive` fans a colour pick out to each
 *     child using `colorTarget`, so stroked outlines recolour their stroke
 *     and the small solid temperature dots recolour their fill — the whole
 *     icon changes colour uniformly.
 *
 * Available universally (all products) — opened from the More panel.
 */

interface WashcareSign {
  key: string;
  label: string;
  /** Full SVG markup (0–100 viewBox), stroke-based via currentColor. */
  svg: string;
}

interface WashcareCategory {
  title: string;
  signs: WashcareSign[];
}

// ---- Shared drawing primitives (all in a 0–100 viewBox) ----------------
const STROKE =
  'fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"';

/** A small SOLID temperature dot (recolours via `fill`). */
const dot = (cx: number, cy: number) =>
  `<circle cx="${cx}" cy="${cy}" r="4.5" fill="currentColor"/>`;

/** Wash tub: sloped vessel with a wavy waterline across the top. */
const TUB = `<path d="M15 47 L11 79 Q11 87 19 87 L81 87 Q89 87 89 79 L85 47" ${STROKE}/><path d="M15 47 Q32 36 50 47 T85 47" ${STROKE}/>`;
/** Bleaching triangle. */
const TRIANGLE = `<path d="M50 15 L87 83 L13 83 Z" ${STROKE}/>`;
/** Drying square. */
const SQUARE = `<path d="M18 21 H82 V85 H18 Z" ${STROKE}/>`;
/** Tumble-dry circle inside the square. */
const TUMBLE_CIRCLE = `<circle cx="50" cy="53" r="21" ${STROKE}/>`;
/** Iron side profile (soleplate + curved nose). */
const IRON = `<path d="M11 71 L80 71 Q91 71 91 61 Q91 54 82 54 L36 54 Q21 54 15 63 Z" ${STROKE}/>`;
/** Dry-clean circle. */
const CIRCLE = `<circle cx="50" cy="50" r="33" ${STROKE}/>`;
/** Simplified hand (fingers + palm) for the hand-wash symbol. */
const HAND = `<path d="M40 52 V64 M47 48 V64 M54 49 V64 M61 53 V64" ${STROKE}/><path d="M36 62 Q36 74 48 74 H56 Q65 74 65 64 V59" ${STROKE}/>`;
/** "Do not …" prohibition cross (drawn over the base symbol). */
const CROSS = `<path d="M16 16 L84 84" ${STROKE}/><path d="M84 16 L16 84" ${STROKE}/>`;
/** Two diagonal bars inside the triangle (non-chlorine bleach). */
const NON_CHLORINE = `<path d="M37 72 L55 46" ${STROKE}/><path d="M47 72 L65 46" ${STROKE}/>`;

const wrap = (inner: string) => `<svg viewBox="0 0 100 100">${inner}</svg>`;

const CATEGORIES: WashcareCategory[] = [
  {
    title: "Washing",
    signs: [
      { key: "wash-normal", label: "Machine Wash", svg: wrap(TUB) },
      { key: "wash-hand", label: "Hand Wash", svg: wrap(TUB + HAND) },
      {
        key: "wash-30",
        label: "Wash 30°C",
        svg: wrap(TUB + dot(50, 68)),
      },
      {
        key: "wash-40",
        label: "Wash 40°C",
        svg: wrap(TUB + dot(41, 68) + dot(59, 68)),
      },
      {
        key: "wash-do-not",
        label: "Do Not Wash",
        svg: wrap(TUB + CROSS),
      },
    ],
  },
  {
    title: "Bleaching",
    signs: [
      { key: "bleach-any", label: "Any Bleach", svg: wrap(TRIANGLE) },
      {
        key: "bleach-non-chlorine",
        label: "Non-Chlorine",
        svg: wrap(TRIANGLE + NON_CHLORINE),
      },
      {
        key: "bleach-do-not",
        label: "Do Not Bleach",
        svg: wrap(TRIANGLE + CROSS),
      },
    ],
  },
  {
    title: "Drying",
    signs: [
      {
        key: "dry-tumble",
        label: "Tumble Dry",
        svg: wrap(SQUARE + TUMBLE_CIRCLE),
      },
      {
        key: "dry-tumble-low",
        label: "Tumble Low",
        svg: wrap(SQUARE + TUMBLE_CIRCLE + dot(50, 53)),
      },
      {
        key: "dry-tumble-do-not",
        label: "No Tumble Dry",
        svg: wrap(SQUARE + TUMBLE_CIRCLE + CROSS),
      },
      {
        key: "dry-line",
        label: "Line Dry",
        svg: wrap(SQUARE + `<path d="M50 30 L50 76" ${STROKE}/>`),
      },
      {
        key: "dry-flat",
        label: "Dry Flat",
        svg: wrap(SQUARE + `<path d="M28 53 L72 53" ${STROKE}/>`),
      },
    ],
  },
  {
    title: "Ironing",
    signs: [
      { key: "iron-any", label: "Iron Any", svg: wrap(IRON) },
      {
        key: "iron-low",
        label: "Iron Low",
        svg: wrap(IRON + dot(50, 62)),
      },
      {
        key: "iron-medium",
        label: "Iron Medium",
        svg: wrap(IRON + dot(41, 62) + dot(59, 62)),
      },
      {
        key: "iron-do-not",
        label: "Do Not Iron",
        svg: wrap(IRON + CROSS),
      },
    ],
  },
  {
    title: "Dry Cleaning",
    signs: [
      { key: "dryclean-any", label: "Dry Clean", svg: wrap(CIRCLE) },
      {
        key: "dryclean-gentle",
        label: "Gentle Clean",
        svg: wrap(CIRCLE + `<path d="M30 90 L70 90" ${STROKE}/>`),
      },
      {
        key: "dryclean-do-not",
        label: "No Dry Clean",
        svg: wrap(CIRCLE + CROSS),
      },
    ],
  },
];

export function WashcareModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);

  if (!open) return null;

  const addSign = (sign: WashcareSign) => {
    if (!canvas) return;

    // Give the parser concrete colours (canvas can't resolve
    // `currentColor`) and a namespaced <svg> root.
    const svgStr = sign.svg
      .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
      .replace(/currentColor/g, "#111111");

    fabric.loadSVGFromString(svgStr, (objects, options) => {
      const parsed = (objects || []).filter(Boolean);
      if (parsed.length === 0) return;

      // Group multi-element symbols; a single-shape symbol comes back as
      // one object. Either way the result classifies as shape/group and
      // recolours through `patchActive` + `colorTarget`.
      const obj = fabric.util.groupSVGElements(parsed, options);

      // IMPORTANT: keep origins at 'left'/'top'. With origin 'center'
      // fabric serialises left/top as the CENTRE, and loadFromJSON
      // re-derives the bounding box differently on reload — which shifts
      // the object on every Front/Back save-load cycle. Manual centring
      // with left/top origins survives the round-trip exactly.
      obj.set({ originX: "left", originY: "top" });
      (obj as any).washcareKey = sign.key;
      obj.name = `washcare-${sign.key}`;

      // Scale to ~22 mm (clamped so it never dwarfs a tiny label).
      const targetMm = Math.min(22, Math.min(lengthMm, widthMm) * 0.6);
      const targetPx = targetMm * MM_TO_PX;
      const raw = Math.max(obj.width || 100, obj.height || 100);
      const scale = targetPx / raw;
      obj.set({ scaleX: scale, scaleY: scale });

      // Manually centre while STRICTLY keeping left/top origins.
      const center = canvas.getCenter();
      const renderedW = (obj.width || 0) * scale;
      const renderedH = (obj.height || 0) * scale;
      obj.set({
        left: center.left - renderedW / 2,
        top: center.top - renderedH / 2,
      });
      obj.setCoords();

      canvas.add(obj);
      canvas.setActiveObject(obj);
      canvas.requestRenderAll();
      canvas.fire("object:modified", { target: obj });
      onClose();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Washcare signs"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-vp-pop w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-vp-border">
          <h2 className="font-semibold text-sm">Washcare signs</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="p-4 overflow-y-auto">
          <p className="text-xs text-vp-muted mb-4">
            Tap a symbol to drop it onto your design. Each is a clean outline
            you can recolour from the toolbar once it's on the canvas.
          </p>
          <div className="space-y-5">
            {CATEGORIES.map((cat) => (
              <section key={cat.title}>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-vp-muted mb-2">
                  {cat.title}
                </h3>
                <div className="grid grid-cols-3 gap-2.5">
                  {cat.signs.map((sign) => (
                    <button
                      key={sign.key}
                      type="button"
                      onClick={() => addSign(sign)}
                      title={sign.label}
                      className="group flex flex-col items-center justify-center gap-1.5 h-24 rounded-lg border border-vp-border hover:border-vp-blue hover:bg-vp-blue-light transition-colors"
                    >
                      <span
                        aria-hidden
                        className="text-vp-ink group-hover:text-vp-blue transition-colors [&>svg]:w-11 [&>svg]:h-11"
                        dangerouslySetInnerHTML={{ __html: sign.svg }}
                      />
                      <span className="text-xs font-medium text-vp-muted leading-none text-center px-1">
                        {sign.label}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
