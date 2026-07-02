import { useEffect, useMemo, useRef, useState } from "react";
import { fabric } from "fabric";
import { useCanvasStore } from "@/store/canvasStore";
import type { CanvasShape, ShapeModifiers } from "@/store/canvasStore";

const VIRTUAL_SIZE = 2000;
const MM_TO_PX = 10;

interface HolePunchPx {
  /** Centre X in PX relative to the snapshot's top-left. */
  cx: number;
  /** Centre Y in PX relative to the snapshot's top-left. */
  cy: number;
  /** Radius in PX. */
  r: number;
}

/**
 * Where is the hole punch in the SNAPSHOT's own pixel space (origin =
 * top-left of the bleed rectangle).
 *
 *  - vertical   → centred horizontally, offset down from the TOP edge
 *  - horizontal → centred vertically, offset inward from the RIGHT edge
 */
/**
 * Where to render the simple hole-punch overlay in the modal — as % of
 * the face's bounding box. The display face is rendered at lengthMm ×
 * widthMm in CSS, so we just normalise the same coordinates the canvas
 * uses to percentages of those dimensions.
 *
 * Per orientation convention:
 *   - vertical   → cx = lengthMm/2, cy = offset (top edge)
 *   - horizontal → cx = lengthMm - offset, cy = widthMm/2 (right edge)
 */
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
  // Radius is expressed relative to the LENGTH axis (CSS width of the
  // face) so a width-driven CSS rule with aspect-ratio: 1/1 keeps it
  // perfectly circular.
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

function computeHolePunch(
  lengthMm: number,
  widthMm: number,
  visualGuides: {
    hasHolePunch: boolean;
    holePunchRadiusMm: number;
    holePunchOffsetFromTopMm: number;
  },
  tagOrientation: "vertical" | "horizontal"
): HolePunchPx | null {
  if (!visualGuides.hasHolePunch || visualGuides.holePunchRadiusMm <= 0) {
    return null;
  }
  const trimW = lengthMm * MM_TO_PX;
  const trimH = widthMm * MM_TO_PX;
  const r = visualGuides.holePunchRadiusMm * MM_TO_PX;
  const offset = visualGuides.holePunchOffsetFromTopMm * MM_TO_PX;
  if (tagOrientation === "horizontal") {
    return { cx: trimW - offset, cy: trimH / 2, r };
  }
  return { cx: trimW / 2, cy: offset, r };
}

/**
 * Take a fabric-exported PNG dataURL and punch a true alpha-zero
 * circular hole at (cx, cy) — same coordinate system the snapshot was
 * drawn in. Uses `globalCompositeOperation = 'destination-out'`.
 * Resolves with the modified dataURL.
 */
function punchHole(
  dataUrl: string,
  hole: HolePunchPx | null
): Promise<string> {
  return new Promise((resolve) => {
    if (!hole) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0);
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(hole.cx, hole.cy, hole.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Full-screen 3D-flip preview modal.
 */
export function FlipPreviewModal() {
  const open = useCanvasStore((s) => s.previewFlipOpen);
  const setOpen = useCanvasStore((s) => s.setPreviewFlipOpen);
  const canvas = useCanvasStore((s) => s.canvas);
  const lengthMm = useCanvasStore((s) => s.canvasLengthMm);
  const widthMm = useCanvasStore((s) => s.canvasWidthMm);
  const productConfig = useCanvasStore((s) => s.productConfig);
  const canvasShape = useCanvasStore((s) => s.canvasShape);
  const shapeModifiers = useCanvasStore((s) => s.shapeModifiers);
  const tagOrientation = useCanvasStore((s) => s.tagOrientation);
  const activeSide = useCanvasStore((s) => s.activeSide);
  const frontDesign = useCanvasStore((s) => s.frontDesign);
  const backDesign = useCanvasStore((s) => s.backDesign);
  const backgroundColor = useCanvasStore((s) => s.backgroundColor);

  const [frontUrl, setFrontUrl] = useState<string | null>(null);
  const [backUrl, setBackUrl] = useState<string | null>(null);
  const [shownSide, setShownSide] = useState<"front" | "back">(activeSide);
  const offRef = useRef<fabric.StaticCanvas | null>(null);

  // Snapshot regen — depends on visible side data + product geometry.
  useEffect(() => {
    if (!open || !canvas) return;
    let cancelled = false;

    (async () => {
      const liveHole = computeHolePunch(
        lengthMm,
        widthMm,
        productConfig.visualGuides,
        tagOrientation
      );
      const liveRaw = snapshotFromLiveCanvas(canvas, lengthMm, widthMm);
      const livePunched = await punchHole(liveRaw, liveHole);

      // The OTHER side. Use the snapshot's own dims / orientation so an
      // asymmetric front+back (e.g. rotated front, unrotated back) shows
      // each face correctly.
      const otherSnap = activeSide === "front" ? backDesign : frontDesign;
      let otherUrl: string | null = null;
      if (otherSnap) {
        const otherLen = otherSnap.lengthMm || lengthMm;
        const otherWid = otherSnap.widthMm || widthMm;
        const otherOrient = otherSnap.tagOrientation || tagOrientation;
        const otherHole = computeHolePunch(
          otherLen,
          otherWid,
          productConfig.visualGuides,
          otherOrient
        );
        const otherRaw = await snapshotFromJson(
          otherSnap.fabric,
          otherSnap.backgroundColor,
          otherLen,
          otherWid,
          offRef
        );
        otherUrl = await punchHole(otherRaw, otherHole);
      }

      if (cancelled) return;
      if (activeSide === "front") {
        setFrontUrl(livePunched);
        setBackUrl(otherUrl);
      } else {
        setBackUrl(livePunched);
        setFrontUrl(otherUrl);
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
    productConfig,
    tagOrientation,
  ]);

  // Cleanup offscreen canvas when the modal closes.
  useEffect(() => {
    if (open) return;
    offRef.current?.dispose();
    offRef.current = null;
    setFrontUrl(null);
    setBackUrl(null);
  }, [open]);

  // Display size — keep the visible aspect ratio matching the product.
  const aspect = lengthMm / Math.max(1, widthMm);
  const baseHeight = 460;
  const dims = useMemo(() => {
    let h = baseHeight;
    let w = baseHeight * aspect;
    if (w > 640) {
      w = 640;
      h = w / aspect;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }, [aspect]);

  if (!open) return null;

  // Single-faced products lock to the front face — no flip animation.
  const supportsBack = productConfig.supportsBackSide;
  const effectiveSide: "front" | "back" = supportsBack ? shownSide : "front";

  // Flip axis: only hang tags flip vertically (rotateX) when landscape;
  // everything else always flips horizontally (rotateY). Computed once so
  // the card + both faces share the exact same axis.
  const flipAxis: "X" | "Y" =
    productConfig.handle === "hang-tags" && lengthMm > widthMm ? "X" : "Y";

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-slate-900/85 backdrop-blur-sm flex flex-col overflow-hidden"
      style={{
        // Reserve a strict bottom buffer (40 px on top of any iOS/Android
        // safe-area inset) so the Front/Back footer always clears the
        // OS taskbar / browser chrome on every viewport.
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 40px)",
      }}
    >
      <header className="h-14 flex items-center justify-between px-5 text-white shrink-0">
        <div className="text-[14px] font-semibold tracking-tight">
          Preview — {productConfig.label}
        </div>
        <button
          aria-label="Close preview"
          onClick={() => setOpen(false)}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6 L18 18 M18 6 L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div
        className="flex-1 min-h-0 flex items-center justify-center px-4"
        style={{ perspective: "1600px" }}
      >
        <div
          className="relative"
          style={{
            width: dims.w,
            height: dims.h,
            transformStyle: "preserve-3d",
            transition: supportsBack
              ? "transform 700ms cubic-bezier(0.4, 0.0, 0.2, 1)"
              : "none",
            // Flip axis: only hang tags flip vertically (rotateX) when
            // landscape; all other products always flip horizontally
            // (rotateY), regardless of aspect ratio. See `flipAxis`.
            transform:
              effectiveSide === "front"
                ? `rotate${flipAxis}(0deg)`
                : `rotate${flipAxis}(180deg)`,
          }}
        >
          <SnapshotFace
            url={frontUrl}
            label="Front"
            shape={canvasShape}
            modifiers={shapeModifiers}
            tagOrientation={tagOrientation}
            lengthMm={lengthMm}
            widthMm={widthMm}
            backgroundColor={frontDesign?.backgroundColor ?? backgroundColor}
            textureCss={productConfig.textureOverlayCss}
            textureSize={getTextureSize(productConfig.handle)}
            blendMode={productConfig.textureOverlayBlendMode}
            opacity={productConfig.textureOverlayOpacity}
            holePct={holePunchPct(
              lengthMm,
              widthMm,
              productConfig.visualGuides,
              tagOrientation
            )}
            flipAxis={flipAxis}
          />
          {supportsBack && (
            <SnapshotFace
              url={backUrl}
              label="Back"
              isBack
              shape={canvasShape}
              modifiers={shapeModifiers}
              tagOrientation={backDesign?.tagOrientation ?? tagOrientation}
              lengthMm={backDesign?.lengthMm ?? lengthMm}
              widthMm={backDesign?.widthMm ?? widthMm}
              backgroundColor={
                backDesign?.backgroundColor ?? backgroundColor
              }
              textureCss={productConfig.textureOverlayCss}
              textureSize={getTextureSize(productConfig.handle)}
              blendMode={productConfig.textureOverlayBlendMode}
              opacity={productConfig.textureOverlayOpacity}
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

      {/* Bottom Front/Back toggle. Extra bottom padding + generous min-
          height ensures the buttons stay clear of the OS taskbar / browser
          status bar on every viewport. */}
      {supportsBack ? (
        <footer
          className="shrink-0 flex items-center justify-center gap-2 px-4 relative z-20 bg-slate-900/30"
          style={{ minHeight: 96, paddingBottom: 24, paddingTop: 16 }}
        >
          <FlipToggleButton
            active={shownSide === "front"}
            onClick={() => setShownSide("front")}
          >
            Front
          </FlipToggleButton>
          <FlipToggleButton
            active={shownSide === "back"}
            onClick={() => setShownSide("back")}
          >
            Back
          </FlipToggleButton>
        </footer>
      ) : (
        <div className="shrink-0" style={{ minHeight: 32 }} />
      )}
    </div>
  );
}

function FlipToggleButton({
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
        "h-10 px-6 rounded-full text-[13px] font-semibold tracking-wide transition-all",
        active
          ? "bg-white text-vp-ink shadow-md"
          : "bg-white/10 text-white/80 hover:bg-white/20",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function SnapshotFace({
  url,
  label,
  isBack,
  shape,
  modifiers,
  tagOrientation,
  lengthMm,
  widthMm,
  backgroundColor,
  textureCss,
  textureSize,
  blendMode,
  opacity,
  holePct,
  flipAxis,
}: {
  url: string | null;
  label: string;
  isBack?: boolean;
  shape: CanvasShape;
  modifiers: ShapeModifiers;
  tagOrientation: "vertical" | "horizontal";
  lengthMm: number;
  widthMm: number;
  backgroundColor: string;
  textureCss: string | null;
  textureSize: string;
  blendMode: "multiply" | "overlay" | "soft-light" | "hard-light";
  opacity: number;
  holePct: { cx: number; cy: number; r: number } | null;
  flipAxis: "X" | "Y";
}) {
  const { clipPath, borderRadius } = silhouetteCss(
    shape,
    modifiers,
    tagOrientation,
    lengthMm,
    widthMm
  );

  // Back face is pre-rotated 180° along the SAME axis the card flips on
  // (passed down from the parent), so it lands upright when the card
  // finishes its rotation.
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
          boxShadow: "0 30px 60px -20px rgba(0,0,0,0.45)",
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
          <div className="w-full h-full flex items-center justify-center text-vp-muted text-[12.5px]">
            No design yet
          </div>
        )}
        {textureCss && (
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background: textureCss,
              backgroundSize: textureSize,
              mixBlendMode: blendMode,
              opacity,
            }}
          />
        )}
        {holePct && (
          <div
            aria-hidden
            className="absolute pointer-events-none rounded-full"
            style={{
              left: `${holePct.cx}%`,
              top: `${holePct.cy}%`,
              width: `${holePct.r * 2}%`,
              // Keep the hole circular regardless of face aspect: width
              // is a %% of length, but height must be the SAME px count.
              // Use aspect-ratio on a square child via CSS calc isn't
              // trivial here — we let the parent be width-driven and
              // override height in absolute terms via padding-bottom.
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

/* ----------------------------- helpers ----------------------------- */

function silhouetteCss(
  shape: CanvasShape,
  modifiers: ShapeModifiers,
  tagOrientation: "vertical" | "horizontal",
  lengthMm: number,
  widthMm: number
): { clipPath?: string; borderRadius?: string } {
  const isHorizontal = tagOrientation === "horizontal";
  const cornersMode = modifiers.cornersMode;
  const maxModMm = Math.max(1, Math.min(lengthMm, widthMm)) * 0.4;
  // `pctX` / `pctY` were originally written to clamp shape MODIFIER
  // values (corner radius, slant length) to the 40 % short-edge cap.
  // They MUST NOT clamp arbitrary coordinates like `lengthMm/2` —
  // doing so produced invalid percentages for the polygon builders.
  // Modifier values are clamped by the caller via `maxModMm`.
  const pctX = (mm: number) => (mm / Math.max(1, lengthMm)) * 100;
  const pctY = (mm: number) => (mm / Math.max(1, widthMm)) * 100;

  switch (shape) {
    case "round-corners": {
      const clampedR = Math.max(0, Math.min(modifiers.cornerRadiusMm, maxModMm));
      const rx = pctX(clampedR).toFixed(2);
      const ry = pctY(clampedR).toFixed(2);
      if (cornersMode === "all") {
        return { borderRadius: `${rx}% / ${ry}%` };
      }
      if (isHorizontal) {
        return {
          borderRadius: `0 ${rx}% ${rx}% 0 / 0 ${ry}% ${ry}% 0`,
        };
      }
      return {
        borderRadius: `${rx}% ${rx}% 0 0 / ${ry}% ${ry}% 0 0`,
      };
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
        // Apex on the RIGHT short edge.
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
        // Apexes on LEFT + RIGHT short edges.
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
    const x = it*it*it*p0x + 3*it*it*t*p1x + 3*it*t*t*p2x + t*t*t*p3x;
    const y = it*it*it*p0y + 3*it*it*t*p1y + 3*it*t*t*p2y + t*t*t*p3y;
    return [x, y];
  };
  if (isHorizontal) {
    // Profile on the RIGHT short edge: shoulders at (L-d, 0) and (L-d, W),
    // apex at (L, W/2). Two cubic Beziers mirror across the horizontal midline.
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
    // Arc on the RIGHT edge. Semi-arc from (L-arcW, 0) → (L-arcW, W) via (L, W/2).
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
  // Mirror the cubic Bezier used by barrelPath (Workspace.tsx) so the
  // modal silhouette matches the canvas exactly. Control coordinate
  // along the bulge axis is `-d/3` → peak touches the bleed edge at
  // midpoint and the curve leaves the corner tangentially (no kink).
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
    // Right bulge — cubic from (L-d, 0) to (L-d, W), peaks at (L, W/2).
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
    // Left bulge — cubic from (d, W) to (d, 0), peaks at (0, W/2).
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
  // Top bulge — cubic from (0, d) to (w, d), peaks at (w/2, 0).
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
  // Bottom bulge — cubic from (w, h-d) to (0, h-d), peaks at (w/2, h).
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
    // Tall pill — top + bottom semi-circles of radius w/2
    const r = lengthMm / 2;
    // Top semi-circle: (0, r) → (w, r) via (w/2, 0)
    for (let i = 0; i <= steps; i++) {
      const theta = Math.PI - Math.PI * (i / steps);
      const x = lengthMm / 2 + Math.cos(theta) * r;
      const y = r - Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
    // Bottom semi-circle: (w, h-r) → (0, h-r) via (w/2, h)
    for (let i = 1; i <= steps; i++) {
      const theta = -Math.PI * (i / steps);
      const x = lengthMm / 2 + Math.cos(theta) * r;
      const y = widthMm - r - Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
  } else {
    // Wide pill — left + right semi-circles of radius h/2
    const r = widthMm / 2;
    // Right semi-circle: (w-r, 0) → (w-r, h) via (w, h/2)
    pts.push(`${pctX(r).toFixed(3)}% 0%`);
    pts.push(`${pctX(lengthMm - r).toFixed(3)}% 0%`);
    for (let i = 0; i <= steps; i++) {
      const theta = -Math.PI / 2 + Math.PI * (i / steps);
      const x = lengthMm - r + Math.cos(theta) * r;
      const y = widthMm / 2 + Math.sin(theta) * r;
      pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
    }
    // Bottom edge to BL
    pts.push(`${pctX(r).toFixed(3)}% 100%`);
    // Left semi-circle: (r, h) → (r, 0) via (0, h/2)
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
  // Quadratic Bezier helper
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
  // TL notch: (r, 0) curves via (r, r) to (0, r)  → here we ENTER the
  // shape at (r, 0). Start there.
  pts.push(`${pctX(r).toFixed(3)}% 0%`);
  pts.push(`${pctX(lengthMm - r).toFixed(3)}% 0%`);
  // TR notch: from (w-r, 0) via (w-r, r) to (w, r)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = quad(
      lengthMm - r, 0, lengthMm - r, r, lengthMm, r, t
    );
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  pts.push(`100% ${pctY(widthMm - r).toFixed(3)}%`);
  // BR notch: from (w, h-r) via (w-r, h-r) to (w-r, h)
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
  // BL notch: from (r, h) via (r, h-r) to (0, h-r)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = quad(r, widthMm, r, widthMm - r, 0, widthMm - r, t);
    pts.push(`${pctX(x).toFixed(3)}% ${pctY(y).toFixed(3)}%`);
  }
  pts.push(`0% ${pctY(r).toFixed(3)}%`);
  // TL notch: from (0, r) via (r, r) to (r, 0) — closes back to start
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
  // TL concave: arc from (0, r) to (r, 0), centre (0, 0), angle π/2 → 0
  pts.push(...arcPoints(0, 0, r, Math.PI / 2, 0, steps, pctX, pctY));
  // top edge → TR concave: arc from (w-r, 0) to (w, r), centre (w, 0), π → π/2
  pts.push(
    ...arcPoints(lengthMm, 0, r, Math.PI, Math.PI / 2, steps, pctX, pctY)
  );
  // right edge → BR concave: (w, h-r) to (w-r, h), centre (w, h), 3π/2 → π
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
  // bottom edge → BL concave: (r, h) to (0, h-r), centre (0, h), 2π → 3π/2
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
    // Long edges (top + bottom) curve inward. Short edges (left + right) straight.
    const d = Math.max(0, Math.min(dMm, widthMm * 0.35));
    const pts: string[] = ["0% 0%"];
    // Top curve from (0,0) → (L,0), control (L/2, d) → y(t) = 2(1-t)t*d
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const xMm = lengthMm * t;
      const yMm = 2 * (1 - t) * t * d;
      pts.push(`${pctX(xMm).toFixed(3)}% ${pctY(yMm).toFixed(3)}%`);
    }
    pts.push("100% 0%", "100% 100%");
    // Bottom curve from (L,W) → (0,W), control (L/2, W-d)
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
    // Cut on the RIGHT corners (TR + BR), round on the LEFT corners (TL + BL).
    const pts: string[] = [];
    // TL rounded: arc from (0, c) to (c, 0), centre (c, c), π → 3π/2
    pts.push(...arcPoints(c, c, c, Math.PI, 1.5 * Math.PI, steps, pctX, pctY));
    pts.push(
      `${pctX(lengthMm - c).toFixed(3)}% 0%`,
      `100% ${pctY(c).toFixed(3)}%`,
      `100% ${pctY(widthMm - c).toFixed(3)}%`,
      `${pctX(lengthMm - c).toFixed(3)}% 100%`,
      `${pctX(c).toFixed(3)}% 100%`
    );
    // BL rounded: arc from (c, h) to (0, h-c), centre (c, h-c), π/2 → π
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

function getTextureSize(handle: string): string {
  if (handle === "woven-labels") return "3px 3px";
  if (handle === "hang-tags") return "8px 8px, 12px 12px, 6px 6px, 4px 4px";
  return "auto";
}

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

function snapshotFromJson(
  fabricJson: any,
  backgroundColor: string,
  lengthMm: number,
  widthMm: number,
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
      c.loadFromJSON(fabricJson, () => {
        c.getObjects().forEach((o: any) => {
          if (o.id === "safety" || o.id === "holePunch") {
            o.set("visible", false);
          }
          if (o.id === "bleed") {
            o.set({
              stroke: "transparent",
              strokeWidth: 0,
              fill: backgroundColor,
            });
          }
        });
        c.renderAll();
        const trimW = lengthMm * MM_TO_PX;
        const trimH = widthMm * MM_TO_PX;
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
