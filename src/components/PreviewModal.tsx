import { useEffect, useMemo, useRef, useState } from "react";
import { fabric } from "fabric";
import { X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { saveDesign } from "@/lib/saveDesign";

const VIRTUAL_SIZE = 2000;
const MM_TO_PX = 10;

/**
 * Final consent / review modal — the screen the user sees after clicking
 * "Next". For two-sided products it renders BOTH front and back with the
 * same `rotateY(180deg)` 3D-flip animation as the in-editor preview, so
 * the user can flip + verify before approving.
 */
export function PreviewModal() {
  const open = useCanvasStore((s) => s.previewOpen);
  const setOpen = useCanvasStore((s) => s.setPreviewOpen);
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const productConfig = useCanvasStore((s) => s.productConfig);
  const productTitle = useCanvasStore((s) => s.productTitle);
  const productSlug = useCanvasStore((s) => s.productSlug);
  const customerId = useCanvasStore((s) => s.customerId);
  const workId = useCanvasStore((s) => s.workId);
  const templateId = useCanvasStore((s) => s.templateId);
  const activeSide = useCanvasStore((s) => s.activeSide);
  const frontDesign = useCanvasStore((s) => s.frontDesign);
  const backDesign = useCanvasStore((s) => s.backDesign);
  const backgroundColor = useCanvasStore((s) => s.backgroundColor);
  const material = useCanvasStore((s) => s.material);
  const canvasShapeStore = useCanvasStore((s) => s.canvasShape);
  const shapeModifiersStore = useCanvasStore((s) => s.shapeModifiers);
  const tagOrientation = useCanvasStore((s) => s.tagOrientation);

  const supportsBack = productConfig.supportsBackSide;

  // Flip axis: only hang tags flip vertically (rotateX) when landscape;
  // every other product always flips horizontally (rotateY).
  const flipAxis: "X" | "Y" =
    productConfig.handle === "hang-tags" && lengthMm > widthMm ? "X" : "Y";

  const [frontUrl, setFrontUrl] = useState<string | null>(null);
  const [backUrl, setBackUrl] = useState<string | null>(null);
  const [shownSide, setShownSide] = useState<"front" | "back">(activeSide);
  const [authorized, setAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offRef = useRef<fabric.StaticCanvas | null>(null);

  // Generate front + back preview PNGs when the modal opens.
  useEffect(() => {
    if (!open || !canvas) return;
    let cancelled = false;

    (async () => {
      const live = snapshotFromLiveCanvas(canvas, lengthMm, widthMm);
      const otherSnap =
        activeSide === "front" ? backDesign : frontDesign;
      let other: string | null = null;
      if (supportsBack && otherSnap) {
        other = await snapshotFromStored(otherSnap, offRef);
      }

      if (cancelled) return;
      if (activeSide === "front") {
        setFrontUrl(live);
        setBackUrl(other);
      } else {
        setBackUrl(live);
        setFrontUrl(other);
      }
      setShownSide(activeSide);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    open,
    canvas,
    lengthMm,
    widthMm,
    activeSide,
    frontDesign,
    backDesign,
    supportsBack,
  ]);

  // Cleanup off-screen canvas when the modal closes.
  useEffect(() => {
    if (open) return;
    offRef.current?.dispose();
    offRef.current = null;
    setFrontUrl(null);
    setBackUrl(null);
    setAuthorized(false);
    setError(null);
    setSubmitting(false);
  }, [open]);

  // BFCache (Back/Forward Cache) restore guard.
  //
  // After a successful save we navigate to the Shopify finalize page via
  // `window.location.href = result.finalizeUrl`. If the user then clicks
  // the browser's Back button, modern browsers restore THIS page from the
  // BFCache — meaning React state (including `submitting = true`) is
  // restored verbatim and the Continue button is stuck on "Saving…"
  // forever, with no JS path to clear it.
  //
  // `pageshow` fires whenever the page is shown — including BFCache
  // restores, where `event.persisted === true`. That's our signal to
  // forcibly reset every transient flag so the modal is interactive
  // again.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      setSubmitting(false);
      setError(null);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // Display size — match the product aspect.
  const aspect = lengthMm / Math.max(1, widthMm);
  const dims = useMemo(() => {
    const baseH = 320;
    let h = baseH;
    let w = baseH * aspect;
    if (w > 480) {
      w = 480;
      h = w / aspect;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }, [aspect]);

  if (!open) return null;

  const effectiveSide: "front" | "back" = supportsBack ? shownSide : "front";

  const handleContinue = async () => {
    if (!canvas) return;
    setSubmitting(true);
    setError(null);

    // Absolute safety net: if the save flow somehow stalls (network
    // hang, fabric callback never fires, etc.), forcibly unstick the
    // button after 20 s so the user can retry — they should NEVER see
    // a permanent "Saving…" state.
    let safetyTimer: number | null = window.setTimeout(() => {
      console.error("[trims-studio] save timed out (20s)");
      setError(
        "Saving is taking longer than expected. Please try again."
      );
      setSubmitting(false);
      safetyTimer = null;
    }, 20000);
    const clearSafety = () => {
      if (safetyTimer != null) {
        window.clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

    try {
      const result = await saveDesign({
        canvas,
        lengthMm,
        widthMm,
        productSlug,
        productTitle,
        customerId,
        workId,
        templateId,
        canvasShape: canvasShapeStore,
        shapeModifiers: shapeModifiersStore,
        tagOrientation,
        backgroundColor,
        activeSide,
        frontDesign,
        backDesign,
        supportsBackSide: supportsBack,
        material,
      });
      clearSafety();
      if (!result?.finalizeUrl) {
        // saveDesign promises always to return a result, but defend
        // against a future refactor that could resolve to null.
        throw new Error("Save returned no finalize URL");
      }
      window.location.href = result.finalizeUrl;
      // On some platforms `window.location.href = …` doesn't navigate
      // immediately (popup blockers, sandboxed iframes, etc.). Drop the
      // spinner shortly after so the button isn't trapped if the
      // redirect is suppressed.
      window.setTimeout(() => setSubmitting(false), 4000);
    } catch (e: any) {
      console.error("[trims-studio] save failed:", e);
      setError(e?.message || "Save failed. Please try again.");
      clearSafety();
      setSubmitting(false);
    } finally {
      // Belt-and-suspenders: if neither the success path's setTimeout
      // nor the catch's setSubmitting fired (e.g. unhandled rejection),
      // make absolutely sure the safety timer is cleared.
      clearSafety();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={() => !submitting && setOpen(false)}
    >
      <div
        className="bg-white rounded-lg shadow-vp-pop max-w-3xl w-full max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 flex items-center justify-between px-4 border-b border-vp-border">
          <h2 className="font-semibold text-sm">Review your design</h2>
          <button
            aria-label="Close"
            onClick={() => !submitting && setOpen(false)}
            disabled={submitting}
            className="w-8 h-8 rounded hover:bg-vp-rail flex items-center justify-center disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 sm:p-6 flex-1 overflow-y-auto vp-scroll">
          <p className="text-sm text-vp-muted mb-4">
            It will be printed like this preview. Make sure you are happy
            before continuing
            {supportsBack ? " — flip to check both sides." : "."}
          </p>

          {/* 3D flip preview panel */}
          <div
            className="bg-vp-rail rounded p-4 sm:p-6 mb-4"
            style={{ perspective: "1400px" }}
          >
            <div className="mx-auto" style={{ width: dims.w, height: dims.h }}>
              <div
                className="relative w-full h-full"
                style={{
                  transformStyle: "preserve-3d",
                  transition: supportsBack
                    ? "transform 600ms cubic-bezier(0.4, 0.0, 0.2, 1)"
                    : "none",
                  // Only hang tags hinge top↔bottom (rotateX) when
                  // landscape; every other product always flips
                  // left↔right (rotateY). See `flipAxis`.
                  transform:
                    effectiveSide === "front"
                      ? `rotate${flipAxis}(0deg)`
                      : `rotate${flipAxis}(180deg)`,
                }}
              >
                <PreviewFace
                  url={frontUrl}
                  label="Front"
                  lengthMm={lengthMm}
                  widthMm={widthMm}
                  backgroundColor={
                    frontDesign?.backgroundColor ?? backgroundColor
                  }
                  shape={canvasShapeStore}
                  cornerRadiusMm={shapeModifiersStore.cornerRadiusMm}
                  slantLengthMm={shapeModifiersStore.slantLengthMm}
                  starPoints={shapeModifiersStore.starPoints}
                  cornersMode={shapeModifiersStore.cornersMode}
                  tagOrientation={tagOrientation}
                  holePct={holePunchPct(
                    lengthMm,
                    widthMm,
                    productConfig.visualGuides,
                    tagOrientation
                  )}
                  flipAxis={flipAxis}
                />
                {supportsBack && (
                  <PreviewFace
                    url={backUrl}
                    label="Back"
                    isBack
                    lengthMm={backDesign?.lengthMm ?? lengthMm}
                    widthMm={backDesign?.widthMm ?? widthMm}
                    backgroundColor={
                      backDesign?.backgroundColor ?? backgroundColor
                    }
                    shape={canvasShapeStore}
                    cornerRadiusMm={shapeModifiersStore.cornerRadiusMm}
                    slantLengthMm={shapeModifiersStore.slantLengthMm}
                    starPoints={shapeModifiersStore.starPoints}
                    cornersMode={shapeModifiersStore.cornersMode}
                    tagOrientation={
                      backDesign?.tagOrientation ?? tagOrientation
                    }
                    holePct={holePunchPct(
                      backDesign?.lengthMm ?? lengthMm,
                      backDesign?.widthMm ?? widthMm,
                      productConfig.visualGuides,
                      backDesign?.tagOrientation ?? tagOrientation
                    )}
                    flipAxis={flipAxis}
                  />
                )}
              </div>
            </div>

            {/* Front / Back toggle — only for two-sided products. */}
            {supportsBack && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <FlipToggle
                  active={shownSide === "front"}
                  onClick={() => setShownSide("front")}
                >
                  Front
                </FlipToggle>
                <FlipToggle
                  active={shownSide === "back"}
                  onClick={() => setShownSide("back")}
                >
                  Back
                </FlipToggle>
              </div>
            )}
          </div>

          <ul className="text-sm space-y-1.5 text-vp-ink/80 mb-4">
            <li>• Are the text and images clear and easy to read?</li>
            <li>• Do the design elements fit in the safety area?</li>
            <li>• Does the background fill out to the edges?</li>
            <li>• Is everything spelled correctly?</li>
            {supportsBack && (
              <li>• Have you reviewed BOTH the front and back?</li>
            )}
          </ul>

          {/* Design confirmation — the WHOLE row is the click target (the
              label wraps both the checkbox and the text), and it's styled
              as a bold, highlighted card so it can't be missed. */}
          <label
            htmlFor="design-confirm-checkbox"
            className="flex items-start gap-3 p-3 rounded-lg bg-vp-rail/70 border border-vp-border cursor-pointer select-none hover:bg-vp-blue-light hover:border-vp-blue/40 transition-colors"
          >
            <input
              id="design-confirm-checkbox"
              type="checkbox"
              checked={authorized}
              onChange={(e) => setAuthorized(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-vp-blue cursor-pointer"
            />
            <span className="text-sm font-semibold text-vp-ink leading-snug">
              I have authorization to use the design. I have reviewed and
              approve it.
            </span>
          </label>

          {error && (
            <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <footer className="border-t border-vp-border p-3 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
          <span className="text-xs text-vp-muted">
            {productTitle} · {lengthMm} × {widthMm} mm
            {supportsBack && backUrl ? " · 2-sided" : ""}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setOpen(false)}
              disabled={submitting}
              className="h-9 px-4 rounded-md border border-vp-border text-sm hover:bg-vp-rail disabled:opacity-40"
            >
              Edit my design
            </button>
            <button
              onClick={handleContinue}
              disabled={!authorized || submitting}
              className="h-9 px-5 rounded-md bg-vp-blue hover:bg-vp-blue-hover disabled:bg-vp-blue/40 disabled:cursor-not-allowed text-white text-sm font-medium flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Saving…
                </>
              ) : (
                "Continue"
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function FlipToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "h-8 px-4 rounded-full text-xs font-semibold tracking-wide transition-all",
        active
          ? "bg-vp-accent text-white shadow-sm"
          : "bg-white text-vp-ink/70 border border-vp-border hover:bg-vp-rail",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function PreviewFace({
  url,
  label,
  isBack,
  lengthMm,
  widthMm,
  backgroundColor,
  shape,
  cornerRadiusMm,
  slantLengthMm,
  starPoints: nStarPoints,
  cornersMode,
  tagOrientation,
  holePct,
  flipAxis,
}: {
  url: string | null;
  label: string;
  isBack?: boolean;
  lengthMm: number;
  widthMm: number;
  backgroundColor: string;
  shape: string;
  cornerRadiusMm: number;
  slantLengthMm: number;
  starPoints: number;
  cornersMode: "top" | "all";
  tagOrientation: "vertical" | "horizontal";
  holePct: { cx: number; cy: number; r: number } | null;
  flipAxis: "X" | "Y";
}) {
  const { clipPath, borderRadius } = silhouetteCss(
    shape,
    {
      cornerRadiusMm,
      slantLengthMm,
      starPoints: nStarPoints,
      cornersMode,
    },
    tagOrientation,
    lengthMm,
    widthMm
  );
  // Back face pre-rotated 180° on the SAME axis as the parent card.
  const backAxis = flipAxis;
  return (
    <div
      aria-label={label}
      className="absolute inset-0"
      style={{
        backfaceVisibility: "hidden",
        transform: isBack ? `rotate${backAxis}(180deg)` : undefined,
      }}
    >
      <div
        className="absolute inset-0 overflow-hidden"
        style={{
          background: backgroundColor || "#ffffff",
          clipPath,
          borderRadius,
          boxShadow: "0 18px 35px -10px rgba(0,0,0,0.25)",
        }}
      >
        {url ? (
          <img
            src={url}
            alt={label}
            className="w-full h-full object-cover select-none"
            draggable={false}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-vp-muted text-[11px]">
            No design yet
          </div>
        )}
        {holePct && (
          <div
            aria-hidden
            className="absolute pointer-events-none rounded-full"
            style={{
              left: `${holePct.cx}%`,
              top: `${holePct.cy}%`,
              width: `${holePct.r * 2}%`,
              aspectRatio: "1 / 1",
              transform: "translate(-50%, -50%)",
              background: "#ffffff",
              boxShadow:
                "inset 0 1px 3px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.08)",
            }}
          />
        )}
      </div>
    </div>
  );
}

/** % coords of the hole punch within a face — see FlipPreviewModal. */
function holePunchPct(
  lengthMm: number,
  widthMm: number,
  visualGuides: {
    hasHolePunch: boolean;
    holePunchRadiusMm: number;
    holePunchOffsetFromTopMm: number;
  },
  tagOrientation: "vertical" | "horizontal"
): { cx: number; cy: number; r: number } | null {
  if (!visualGuides.hasHolePunch || visualGuides.holePunchRadiusMm <= 0) {
    return null;
  }
  const off = visualGuides.holePunchOffsetFromTopMm;
  const rMm = visualGuides.holePunchRadiusMm;
  const r = (rMm / Math.max(1, lengthMm)) * 100;
  if (tagOrientation === "horizontal") {
    return {
      cx: ((lengthMm - off) / Math.max(1, lengthMm)) * 100,
      cy: 50,
      r,
    };
  }
  return {
    cx: 50,
    cy: (off / Math.max(1, widthMm)) * 100,
    r,
  };
}

/* ----------------------- snapshot helpers ----------------------- */

function snapshotFromLiveCanvas(
  canvas: fabric.Canvas,
  lengthMm: number,
  widthMm: number
): string {
  const safety = canvas.getObjects().find((o: any) => o.id === "safety");
  const bleed = canvas.getObjects().find((o: any) => o.id === "bleed");
  const hole = canvas.getObjects().find((o: any) => o.id === "holePunch");
  const prevCanvasBg = (canvas as any).backgroundColor;
  const prev = {
    safetyOpacity: safety?.opacity ?? 1,
    bleedStroke: (bleed as any)?.stroke,
    bleedStrokeWidth: (bleed as any)?.strokeWidth,
    bleedFill: (bleed as any)?.fill,
    holeOpacity: hole?.opacity ?? 1,
  };
  if (safety) safety.set("opacity", 0);
  if (bleed)
    bleed.set({ stroke: "transparent", strokeWidth: 0, fill: "transparent" });
  if (hole) hole.set("opacity", 0);
  (canvas as any).backgroundColor = "transparent";
  canvas.renderAll();
  const trimW = lengthMm * MM_TO_PX;
  const trimH = widthMm * MM_TO_PX;
  const cx = VIRTUAL_SIZE / 2;
  const cy = VIRTUAL_SIZE / 2;
  const url = canvas.toDataURL({
    format: "png",
    left: cx - trimW / 2,
    top: cy - trimH / 2,
    width: trimW,
    height: trimH,
    multiplier: 1,
  });
  if (safety) safety.set("opacity", prev.safetyOpacity);
  if (bleed)
    bleed.set({
      stroke: prev.bleedStroke,
      strokeWidth: prev.bleedStrokeWidth,
      fill: prev.bleedFill,
    });
  if (hole) hole.set("opacity", prev.holeOpacity);
  (canvas as any).backgroundColor = prevCanvasBg;
  canvas.renderAll();
  return url;
}

function snapshotFromStored(
  snap: { fabric: any; backgroundColor: string; lengthMm: number; widthMm: number },
  offRef: React.MutableRefObject<fabric.StaticCanvas | null>
): Promise<string> {
  return new Promise((resolve) => {
    if (!offRef.current) {
      offRef.current = new fabric.StaticCanvas(null as any, {
        width: VIRTUAL_SIZE,
        height: VIRTUAL_SIZE,
      });
    }
    const c = offRef.current;
    try {
      const payload =
        typeof snap.fabric === "string"
          ? JSON.parse(snap.fabric)
          : { ...(snap.fabric || {}) };
      c.loadFromJSON(payload, () => {
        c.getObjects().forEach((o: any) => {
          if (o.id === "safety" || o.id === "holePunch") {
            o.set("visible", false);
          }
          if (o.id === "bleed") {
            o.set({
              stroke: "transparent",
              strokeWidth: 0,
              fill: snap.backgroundColor,
            });
          }
        });
        c.renderAll();
        const trimW = snap.lengthMm * MM_TO_PX;
        const trimH = snap.widthMm * MM_TO_PX;
        const cx = VIRTUAL_SIZE / 2;
        const cy = VIRTUAL_SIZE / 2;
        resolve(
          c.toDataURL({
            format: "png",
            left: cx - trimW / 2,
            top: cy - trimH / 2,
            width: trimW,
            height: trimH,
            multiplier: 1,
          })
        );
      });
    } catch {
      resolve("");
    }
  });
}

function silhouetteCss(
  shape: string,
  modifiers: {
    cornerRadiusMm: number;
    slantLengthMm: number;
    starPoints: number;
    cornersMode: "top" | "all";
  },
  tagOrientation: "vertical" | "horizontal",
  lengthMm: number,
  widthMm: number
): { clipPath?: string; borderRadius?: string } {
  const isHorizontal = tagOrientation === "horizontal";
  const cornersMode = modifiers.cornersMode;
  const maxModMm = Math.max(1, Math.min(lengthMm, widthMm)) * 0.4;
  // `pctX` / `pctY` accept arbitrary coordinate values (not just
  // shape modifiers). Modifier values get clamped explicitly at each
  // call site via `Math.min(value, maxModMm)`.
  const pctX = (mm: number) => (mm / Math.max(1, lengthMm)) * 100;
  const pctY = (mm: number) => (mm / Math.max(1, widthMm)) * 100;

  switch (shape) {
    case "round-corners": {
      const clampedR = Math.max(0, Math.min(modifiers.cornerRadiusMm, maxModMm));
      const rx = pctX(clampedR).toFixed(2);
      const ry = pctY(clampedR).toFixed(2);
      if (cornersMode === "all") return { borderRadius: `${rx}% / ${ry}%` };
      if (isHorizontal)
        return { borderRadius: `0 ${rx}% ${rx}% 0 / 0 ${ry}% ${ry}% 0` };
      return { borderRadius: `${rx}% ${rx}% 0 0 / ${ry}% ${ry}% 0 0` };
    }
    case "cut-corners": {
      const clampedS = Math.max(0, Math.min(modifiers.slantLengthMm, maxModMm));
      const cx = pctX(clampedS).toFixed(2);
      const cy = pctY(clampedS).toFixed(2);
      if (cornersMode === "all") {
        return {
          clipPath: `polygon(${cx}% 0, ${100 - +cx}% 0, 100% ${cy}%, 100% ${100 - +cy}%, ${100 - +cx}% 100%, ${cx}% 100%, 0 ${100 - +cy}%, 0 ${cy}%)`,
        };
      }
      if (isHorizontal) {
        return {
          clipPath: `polygon(0 0, ${100 - +cx}% 0, 100% ${cy}%, 100% ${100 - +cy}%, ${100 - +cx}% 100%, 0 100%)`,
        };
      }
      return {
        clipPath: `polygon(${cx}% 0, ${100 - +cx}% 0, 100% ${cy}%, 100% 100%, 0 100%, 0 ${cy}%)`,
      };
    }
    case "oval":
      return { borderRadius: "50%" };
    case "star": {
      const n = Math.max(5, modifiers.starPoints);
      const total = n * 2;
      const inner = 0.38;
      const out: string[] = [];
      const cx = 50;
      const cy = 50;
      const startAngle = -Math.PI / 2;
      for (let i = 0; i < total; i++) {
        const a = startAngle + (i * Math.PI) / n;
        const r = i % 2 === 0 ? 50 : 50 * inner;
        out.push(
          `${(cx + Math.cos(a) * r).toFixed(2)}% ${(cy + Math.sin(a) * r).toFixed(2)}%`
        );
      }
      return { clipPath: `polygon(${out.join(", ")})` };
    }
    case "scalloped": {
      const rMm = Math.max(
        0,
        Math.min(modifiers.cornerRadiusMm, maxModMm)
      );
      return { clipPath: scallopedClipPolygon(rMm, lengthMm, widthMm, pctX, pctY) };
    }
    case "pointed-top": {
      const pMm = Math.max(
        0,
        Math.min(modifiers.slantLengthMm, maxModMm)
      );
      if (isHorizontal) {
        const pts = [
          `100% ${pctY(widthMm / 2).toFixed(3)}%`,
          `${pctX(lengthMm - pMm).toFixed(3)}% 100%`,
          `0% 100%`,
          `0% 0%`,
          `${pctX(lengthMm - pMm).toFixed(3)}% 0%`,
        ];
        return { clipPath: `polygon(${pts.join(", ")})` };
      }
      const pts = [
        `${pctX(lengthMm / 2).toFixed(3)}% 0%`,
        `100% ${pctY(pMm).toFixed(3)}%`,
        `100% 100%`,
        `0% 100%`,
        `0% ${pctY(pMm).toFixed(3)}%`,
      ];
      return { clipPath: `polygon(${pts.join(", ")})` };
    }
    case "hexagon-pointed": {
      const pMm = Math.max(
        0,
        Math.min(modifiers.slantLengthMm, maxModMm)
      );
      if (isHorizontal) {
        const pts = [
          `100% ${pctY(widthMm / 2).toFixed(3)}%`,
          `${pctX(lengthMm - pMm).toFixed(3)}% 100%`,
          `${pctX(pMm).toFixed(3)}% 100%`,
          `0% ${pctY(widthMm / 2).toFixed(3)}%`,
          `${pctX(pMm).toFixed(3)}% 0%`,
          `${pctX(lengthMm - pMm).toFixed(3)}% 0%`,
        ];
        return { clipPath: `polygon(${pts.join(", ")})` };
      }
      const pts = [
        `${pctX(lengthMm / 2).toFixed(3)}% 0%`,
        `100% ${pctY(pMm).toFixed(3)}%`,
        `100% ${pctY(widthMm - pMm).toFixed(3)}%`,
        `${pctX(lengthMm / 2).toFixed(3)}% 100%`,
        `0% ${pctY(widthMm - pMm).toFixed(3)}%`,
        `0% ${pctY(pMm).toFixed(3)}%`,
      ];
      return { clipPath: `polygon(${pts.join(", ")})` };
    }
    case "flared": {
      const longEdgeMm = isHorizontal ? widthMm : lengthMm;
      const dMm = Math.max(0, Math.min(modifiers.slantLengthMm, longEdgeMm * 0.35));
      return {
        clipPath: flaredClipPolygon(dMm, lengthMm, widthMm, pctX, pctY, isHorizontal),
      };
    }
    case "mixed-cut-round": {
      const cMm = Math.max(
        0,
        Math.min(modifiers.slantLengthMm, maxModMm)
      );
      return {
        clipPath: mixedCutRoundClipPolygon(
          cMm, lengthMm, widthMm, pctX, pctY, isHorizontal
        ),
      };
    }
    case "boutique": {
      const shortEdgeMm = isHorizontal ? lengthMm : widthMm;
      const dMm = Math.max(0, Math.min(modifiers.slantLengthMm, shortEdgeMm * 0.45));
      return {
        clipPath: boutiqueClipPolygon(
          dMm, lengthMm, widthMm, pctX, pctY, isHorizontal
        ),
      };
    }
    case "arch":
      return {
        clipPath: archClipPolygon(lengthMm, widthMm, pctX, pctY, isHorizontal),
      };
    case "barrel": {
      const shortEdgeMm = isHorizontal ? lengthMm : widthMm;
      const bMm = Math.max(0, Math.min(modifiers.slantLengthMm, shortEdgeMm * 0.45));
      return {
        clipPath: barrelClipPolygon(
          bMm, lengthMm, widthMm, pctX, pctY, isHorizontal
        ),
      };
    }
    case "pill":
      return { clipPath: pillClipPolygon(lengthMm, widthMm, pctX, pctY) };
    case "ticket": {
      const nMm = Math.max(0, Math.min(modifiers.cornerRadiusMm, maxModMm));
      return {
        clipPath: ticketClipPolygon(nMm, lengthMm, widthMm, pctX, pctY),
      };
    }
    default:
      return {};
  }
}

/* ----- Polygon approximations for the extended premium shapes ----- */

function boutiqueClipPolygon(
  depthMm: number,
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number,
  isHorizontal: boolean
): string {
  const steps = 12;
  const pts: string[] = [];
  const cubic = (
    p0x: number, p0y: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    p3x: number, p3y: number,
    t: number
  ) => {
    const it = 1 - t;
    return [
      it*it*it*p0x + 3*it*it*t*p1x + 3*it*t*t*p2x + t*t*t*p3x,
      it*it*it*p0y + 3*it*it*t*p1y + 3*it*t*t*p2y + t*t*t*p3y,
    ];
  };
  if (isHorizontal) {
    const d = Math.max(0, Math.min(depthMm, lengthMm * 0.45));
    pts.push(`0% 0%`, `${pctX(lengthMm - d).toFixed(3)}% 0%`);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const [x, y] = cubic(
        lengthMm - d, 0,
        lengthMm - d, widthMm * 0.15,
        lengthMm, widthMm * 0.3,
        lengthMm, widthMm / 2,
        t
      );
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const [x, y] = cubic(
        lengthMm, widthMm / 2,
        lengthMm, widthMm * 0.7,
        lengthMm - d, widthMm * 0.85,
        lengthMm - d, widthMm,
        t
      );
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
    pts.push(`0% 100%`);
    return `polygon(${pts.join(", ")})`;
  }
  const d = Math.max(0, Math.min(depthMm, widthMm * 0.45));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = cubic(
      0, d, lengthMm * 0.15, d, lengthMm * 0.3, 0, lengthMm / 2, 0, t
    );
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = cubic(
      lengthMm / 2, 0, lengthMm * 0.7, 0, lengthMm * 0.85, d, lengthMm, d, t
    );
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  pts.push(`100% 100%`, `0% 100%`);
  return `polygon(${pts.join(", ")})`;
}

function archClipPolygon(
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number,
  isHorizontal: boolean
): string {
  const steps = 16;
  const pts: string[] = [];
  if (isHorizontal) {
    const r = widthMm / 2;
    const arcW = Math.min(r, lengthMm * 0.5);
    pts.push(`0% 0%`, `${pctX(lengthMm - arcW).toFixed(3)}% 0%`);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const theta = -Math.PI / 2 + Math.PI * t;
      const x = lengthMm - arcW + Math.cos(theta) * arcW;
      const y = widthMm / 2 + Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
    pts.push(`0% 100%`);
    return `polygon(${pts.join(", ")})`;
  }
  const r = lengthMm / 2;
  const arcH = Math.min(r, widthMm * 0.5);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const theta = Math.PI - Math.PI * t;
    const x = lengthMm / 2 + Math.cos(theta) * r;
    const y = arcH - Math.sin(theta) * arcH;
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  pts.push(`100% 100%`, `0% 100%`);
  return `polygon(${pts.join(", ")})`;
}

function barrelClipPolygon(
  bulgeMm: number,
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number,
  isHorizontal: boolean
): string {
  const steps = 12;
  const pts: string[] = [];
  const sampleCubic = (
    p0x: number, p0y: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    p3x: number, p3y: number,
    t: number
  ): [number, number] => {
    const it = 1 - t;
    return [
      it * it * it * p0x + 3 * it * it * t * p1x + 3 * it * t * t * p2x + t * t * t * p3x,
      it * it * it * p0y + 3 * it * it * t * p1y + 3 * it * t * t * p2y + t * t * t * p3y,
    ];
  };
  if (isHorizontal) {
    const d = Math.max(0, Math.min(bulgeMm, lengthMm * 0.45));
    const k = d / 3;
    pts.push(`${pctX(d).toFixed(3)}% 0%`, `${pctX(lengthMm - d).toFixed(3)}% 0%`);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const [x, y] = sampleCubic(
        lengthMm - d, 0,
        lengthMm + k, 0,
        lengthMm + k, widthMm,
        lengthMm - d, widthMm,
        t
      );
      pts.push(
        `${pctX(Math.min(lengthMm, x)).toFixed(3)}% ${pctY(y).toFixed(3)}%`
      );
    }
    pts.push(`${pctX(d).toFixed(3)}% 100%`);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const [x, y] = sampleCubic(
        d, widthMm,
        -k, widthMm,
        -k, 0,
        d, 0,
        t
      );
      pts.push(
        `${pctX(Math.max(0, x)).toFixed(3)}% ${pctY(y).toFixed(3)}%`
      );
    }
    return `polygon(${pts.join(", ")})`;
  }
  const d = Math.max(0, Math.min(bulgeMm, widthMm * 0.45));
  const k = d / 3;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = sampleCubic(
      0, d,
      0, -k,
      lengthMm, -k,
      lengthMm, d,
      t
    );
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(Math.max(0, y)).toFixed(3)}%`);
  }
  pts.push(`100% ${pctY(widthMm - d).toFixed(3)}%`);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = sampleCubic(
      lengthMm, widthMm - d,
      lengthMm, widthMm + k,
      0, widthMm + k,
      0, widthMm - d,
      t
    );
    pts.push(
      `${pctX(x).toFixed(3)}% ${pctY(Math.min(widthMm, y)).toFixed(3)}%`
    );
  }
  return `polygon(${pts.join(", ")})`;
}

function pillClipPolygon(
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number
): string {
  const steps = 12;
  const pts: string[] = [];
  if (widthMm >= lengthMm) {
    const r = lengthMm / 2;
    for (let i = 0; i <= steps; i++) {
      const theta = Math.PI - Math.PI * (i / steps);
      const x = lengthMm / 2 + Math.cos(theta) * r;
      const y = r - Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
    for (let i = 1; i <= steps; i++) {
      const theta = -Math.PI * (i / steps);
      const x = lengthMm / 2 + Math.cos(theta) * r;
      const y = widthMm - r - Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
  } else {
    const r = widthMm / 2;
    pts.push(`${pctX(r).toFixed(3)}% 0%`);
    pts.push(`${pctX(lengthMm - r).toFixed(3)}% 0%`);
    for (let i = 0; i <= steps; i++) {
      const theta = -Math.PI / 2 + Math.PI * (i / steps);
      const x = lengthMm - r + Math.cos(theta) * r;
      const y = widthMm / 2 + Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
    pts.push(`${pctX(r).toFixed(3)}% 100%`);
    for (let i = 0; i <= steps; i++) {
      const theta = Math.PI / 2 + Math.PI * (i / steps);
      const x = r + Math.cos(theta) * r;
      const y = widthMm / 2 + Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
  }
  return `polygon(${pts.join(", ")})`;
}

function ticketClipPolygon(
  notchMm: number,
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number
): string {
  const r = Math.max(0, Math.min(notchMm, lengthMm * 0.4, widthMm * 0.4));
  const steps = 6;
  const pts: string[] = [];
  const quad = (
    p0x: number, p0y: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    t: number
  ) => {
    const it = 1 - t;
    return [
      it * it * p0x + 2 * it * t * p1x + t * t * p2x,
      it * it * p0y + 2 * it * t * p1y + t * t * p2y,
    ];
  };
  pts.push(`${pctX(r).toFixed(3)}% 0%`);
  pts.push(`${pctX(lengthMm - r).toFixed(3)}% 0%`);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = quad(
      lengthMm - r, 0, lengthMm - r, r, lengthMm, r, t
    );
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  pts.push(`100% ${pctY(widthMm - r).toFixed(3)}%`);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = quad(
      lengthMm, widthMm - r,
      lengthMm - r, widthMm - r,
      lengthMm - r, widthMm,
      t
    );
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  pts.push(`${pctX(r).toFixed(3)}% 100%`);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = quad(r, widthMm, r, widthMm - r, 0, widthMm - r, t);
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  pts.push(`0% ${pctY(r).toFixed(3)}%`);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const [x, y] = quad(0, r, r, r, r, 0, t);
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  return `polygon(${pts.join(", ")})`;
}

/* ----- Polygon approximations for curved shapes (CSS clip-path) ---- */

function arcPoints(
  cxMm: number,
  cyMm: number,
  rMm: number,
  startAngle: number,
  endAngle: number,
  steps: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number
): string[] {
  const out: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = startAngle + (endAngle - startAngle) * t;
    const xMm = cxMm + Math.cos(a) * rMm;
    const yMm = cyMm + Math.sin(a) * rMm;
    out.push(`${pctX(xMm).toFixed(3)}% ${pctY(yMm).toFixed(3)}%`);
  }
  return out;
}

function scallopedClipPolygon(
  rMm: number,
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number
): string {
  const r = Math.max(0, Math.min(rMm, lengthMm / 2, widthMm / 2));
  const steps = 8;
  const pts: string[] = [];
  pts.push(...arcPoints(0, 0, r, Math.PI / 2, 0, steps, pctX, pctY));
  pts.push(
    ...arcPoints(lengthMm, 0, r, Math.PI, Math.PI / 2, steps, pctX, pctY)
  );
  pts.push(
    ...arcPoints(
      lengthMm,
      widthMm,
      r,
      (3 * Math.PI) / 2,
      Math.PI,
      steps,
      pctX,
      pctY
    )
  );
  pts.push(
    ...arcPoints(
      0,
      widthMm,
      r,
      2 * Math.PI,
      (3 * Math.PI) / 2,
      steps,
      pctX,
      pctY
    )
  );
  return `polygon(${pts.join(", ")})`;
}

function flaredClipPolygon(
  dMm: number,
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number,
  isHorizontal: boolean
): string {
  const steps = 10;
  if (isHorizontal) {
    const d = Math.max(0, Math.min(dMm, widthMm * 0.35));
    const pts: string[] = ["0% 0%"];
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const xMm = lengthMm * t;
      const yMm = 2 * (1 - t) * t * d;
      pts.push(`${pctX(xMm).toFixed(3)}% ${pctY(yMm).toFixed(3)}%`);
    }
    pts.push("100% 0%", "100% 100%");
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const xMm = lengthMm * (1 - t);
      const yMm = widthMm - 2 * (1 - t) * t * d;
      pts.push(`${pctX(xMm).toFixed(3)}% ${pctY(yMm).toFixed(3)}%`);
    }
    pts.push("0% 100%");
    return `polygon(${pts.join(", ")})`;
  }
  const d = Math.max(0, Math.min(dMm, lengthMm * 0.35));
  const pts: string[] = ["0% 0%", "100% 0%"];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const xMm = lengthMm - 2 * (1 - t) * t * d;
    const yMm = widthMm * t;
    pts.push(`${pctX(xMm).toFixed(3)}% ${pctY(yMm).toFixed(3)}%`);
  }
  pts.push("100% 100%", "0% 100%");
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const xMm = 2 * (1 - t) * t * d;
    const yMm = widthMm * (1 - t);
    pts.push(`${pctX(xMm).toFixed(3)}% ${pctY(yMm).toFixed(3)}%`);
  }
  return `polygon(${pts.join(", ")})`;
}

function mixedCutRoundClipPolygon(
  cMm: number,
  lengthMm: number,
  widthMm: number,
  pctX: (mm: number) => number,
  pctY: (mm: number) => number,
  isHorizontal: boolean
): string {
  const c = Math.max(0, Math.min(cMm, lengthMm * 0.4, widthMm * 0.4));
  const steps = 8;
  if (isHorizontal) {
    const pts: string[] = [];
    pts.push(...arcPoints(c, c, c, Math.PI, 1.5 * Math.PI, steps, pctX, pctY));
    pts.push(
      `${pctX(lengthMm - c).toFixed(3)}% 0%`,
      `100% ${pctY(c).toFixed(3)}%`,
      `100% ${pctY(widthMm - c).toFixed(3)}%`,
      `${pctX(lengthMm - c).toFixed(3)}% 100%`,
      `${pctX(c).toFixed(3)}% 100%`
    );
    pts.push(
      ...arcPoints(c, widthMm - c, c, Math.PI / 2, Math.PI, steps, pctX, pctY)
    );
    return `polygon(${pts.join(", ")})`;
  }
  const pts: string[] = [
    `${pctX(c).toFixed(3)}% 0%`,
    `${pctX(lengthMm - c).toFixed(3)}% 0%`,
    `100% ${pctY(c).toFixed(3)}%`,
    `100% ${pctY(widthMm - c).toFixed(3)}%`,
  ];
  pts.push(
    ...arcPoints(
      lengthMm - c,
      widthMm - c,
      c,
      0,
      Math.PI / 2,
      steps,
      pctX,
      pctY
    )
  );
  pts.push(`${pctX(c).toFixed(3)}% 100%`);
  pts.push(
    ...arcPoints(c, widthMm - c, c, Math.PI / 2, Math.PI, steps, pctX, pctY)
  );
  pts.push(`0% ${pctY(c).toFixed(3)}%`);
  return `polygon(${pts.join(", ")})`;
}
