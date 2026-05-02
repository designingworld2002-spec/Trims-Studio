import { useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE, MM_TO_PX } from "./Workspace";

/**
 * "Table size" modal — opens from the More panel. The user picks a row
 * and column count, then clicking "Add table" drops a fabric.Group of
 * intersecting horizontal + vertical lines onto the canvas.
 *
 * We use lines (not rects with strokes) so the user can later adjust
 * stroke colour / width via the contextual toolbar's stroke controls
 * by ungrouping the table — and so the `getColorTarget` routing in
 * canvasStore correctly classifies the children as stroke-coloured.
 */
export function TableModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);

  if (!open) return null;

  const addTable = () => {
    if (!canvas) return;

    // Default footprint: ~60% of the smaller trim axis. Square cells
    // when possible, but never larger than the trim — keep the table
    // inside the safe area on first drop.
    const target = Math.min(lengthMm, widthMm) * MM_TO_PX * 0.6;
    const w = target;
    const h = target * (rows / cols);

    const cellW = w / cols;
    const cellH = h / rows;
    const lines: fabric.Object[] = [];

    // Horizontal lines: rows + 1 (top, between rows, bottom).
    for (let r = 0; r <= rows; r++) {
      lines.push(
        new fabric.Line([0, r * cellH, w, r * cellH], {
          stroke: "#000000",
          strokeWidth: 1,
        })
      );
    }
    // Vertical lines: cols + 1.
    for (let c = 0; c <= cols; c++) {
      lines.push(
        new fabric.Line([c * cellW, 0, c * cellW, h], {
          stroke: "#000000",
          strokeWidth: 1,
        })
      );
    }

    const table = new fabric.Group(lines, {
      left: VIRTUAL_SIZE / 2,
      top: VIRTUAL_SIZE / 2,
      originX: "center",
      originY: "center",
    });
    // Tag so future code can tell this is a table (e.g. for ungroup
    // shortcuts or table-specific toolbars in a later phase).
    (table as any).tableMeta = { rows, cols };

    canvas.add(table);
    canvas.setActiveObject(table);
    canvas.requestRenderAll();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Table size"
      className="fixed inset-0 z-50 bg-vp-ink/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-vp-pop w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 flex items-center justify-between px-4 border-b border-vp-border">
          <h2 className="font-semibold text-sm">Table size</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="p-5 space-y-4">
          <Stepper label="Rows" value={rows} min={1} max={20} onChange={setRows} />
          <Stepper label="Columns" value={cols} min={1} max={20} onChange={setCols} />
          <p className="text-[11px] text-vp-muted">
            Lines are placed on the canvas as a single group so you can move
            and resize the table as a whole. Click again to ungroup and
            recolour individual lines.
          </p>
        </div>
        <footer className="border-t border-vp-border p-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-9 px-4 rounded-md border border-vp-border text-sm hover:bg-vp-rail"
          >
            Cancel
          </button>
          <button
            onClick={addTable}
            className="h-9 px-5 rounded-md bg-vp-blue hover:bg-vp-blue-hover text-white text-sm font-medium"
          >
            Add table
          </button>
        </footer>
      </div>
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center rounded-md border border-vp-border h-9">
        <button
          onClick={dec}
          aria-label={`Decrease ${label.toLowerCase()}`}
          className="w-9 h-9 flex items-center justify-center hover:bg-vp-rail rounded-l-md disabled:opacity-40"
          disabled={value <= min}
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
          }}
          className="w-12 h-full text-center text-sm font-medium border-x border-vp-border focus:outline-none"
        />
        <button
          onClick={inc}
          aria-label={`Increase ${label.toLowerCase()}`}
          className="w-9 h-9 flex items-center justify-center hover:bg-vp-rail rounded-r-md disabled:opacity-40"
          disabled={value >= max}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
