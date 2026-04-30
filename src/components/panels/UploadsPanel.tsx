import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import { VIRTUAL_SIZE, MM_TO_PX } from "../Workspace";

export function UploadsPanel() {
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const inputRef = useRef<HTMLInputElement>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);

  const handleFiles = (files: FileList | null) => {
    if (!files || !canvas) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        if (!dataUrl) return;
        setThumbs((t) => [dataUrl, ...t].slice(0, 24));
        addToCanvas(dataUrl);
      };
      reader.readAsDataURL(file);
    });
  };

  const addToCanvas = (dataUrl: string) => {
    if (!canvas) return;
    fabric.Image.fromURL(dataUrl, (img) => {
      // Fit image inside ~70% of trim area.
      const trimW = lengthMm * MM_TO_PX;
      const trimH = widthMm * MM_TO_PX;
      const target = Math.min(trimW, trimH) * 0.7;
      const iw = img.width || target;
      const ih = img.height || target;
      const scale = target / Math.max(iw, ih);
      img.set({
        left: VIRTUAL_SIZE / 2,
        top: VIRTUAL_SIZE / 2,
        originX: "center",
        originY: "center",
        scaleX: scale,
        scaleY: scale,
      });
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
    });
  };

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="w-full h-11 rounded-md bg-vp-blue hover:bg-vp-blue-hover text-white text-sm font-medium flex items-center justify-center gap-2"
      >
        <Upload className="w-4 h-4" />
        Upload from this device
      </button>

      <div className="text-xs text-vp-muted text-center py-1">
        Sign in to access previous uploads
      </div>

      {thumbs.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {thumbs.map((src, i) => (
            <button
              key={i}
              onClick={() => addToCanvas(src)}
              className="aspect-square rounded border border-vp-border overflow-hidden bg-vp-rail hover:border-vp-blue"
            >
              <img src={src} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
