import { Trash2 } from "lucide-react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE } from "../Workspace";

export function TextPanel() {
  const canvas = useCanvasStore((s) => s.canvas);
  const selected = useCanvasStore((s) => s.selected);
  const patchActive = useCanvasStore((s) => s.patchActive);

  const isText = selected?.type === "text";

  const addText = () => {
    if (!canvas) return;
    const t = new fabric.IText("Add a heading", {
      left: VIRTUAL_SIZE / 2,
      top: VIRTUAL_SIZE / 2,
      originX: "center",
      originY: "center",
      fontFamily: "Arimo",
      fontSize: 48,
      fill: "#0a1f44",
    });
    canvas.add(t);
    canvas.setActiveObject(t);
    canvas.requestRenderAll();
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-vp-muted leading-relaxed">
        Edit your text below, or click on the field you'd like to edit directly
        on your design.
      </p>

      {isText && (
        <div className="relative">
          <input
            type="text"
            value={selected.text}
            onChange={(e) => patchActive({ text: e.target.value })}
            placeholder="Type your text"
            className="w-full h-10 pr-9 pl-3 rounded-md border border-vp-border text-sm focus:outline-none focus:border-vp-blue"
          />
          <button
            aria-label="Clear text"
            onClick={() => patchActive({ text: "" })}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded hover:bg-vp-rail flex items-center justify-center"
          >
            <Trash2 className="w-3.5 h-3.5 text-vp-muted" />
          </button>
        </div>
      )}

      <button
        onClick={addText}
        className="w-full h-11 rounded-md bg-vp-blue hover:bg-vp-blue-hover text-white text-sm font-medium"
      >
        + New text field
      </button>
    </div>
  );
}
