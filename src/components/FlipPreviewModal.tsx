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

  // Hole punch in BLEED-SNAPSHOT space → also valid in face-display space
  // after a proportional rescale. We pass the snapshot dimensions and let
  // SnapshotFace project them onto its rendered size.
  const liveHolePx = computeHolePunch(
    lengthMm,
    widthMm,
    productConfig.visualGuides,
    tagOrientation
  );

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
            transform:
              effectiveSide === "front" ? "rotateY(0deg)" : "rotateY(180deg)",
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
            hole={liveHolePx}
            displayDims={dims}
            snapshotDims={{ w: lengthMm * MM_TO_PX, h: widthMm * MM_TO_PX }}
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
              hole={computeHolePunch(
                backDesign?.lengthMm ?? lengthMm,
                backDesign?.widthMm ?? widthMm,
                productConfig.visualGuides,
                backDesign?.tagOrientation ?? tagOrientation
              )}
              displayDims={dims}
              snapshotDims={{
                w: (backDesign?.lengthMm ?? lengthMm) * MM_TO_PX,
                h: (backDesign?.widthMm ?? widthMm) * MM_TO_PX,
              }}
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
  hole,
  displayDims,
  snapshotDims,
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
  hole: HolePunchPx | null;
  displayDims: { w: number; h: number };
  snapshotDims: { w: number; h: number };
}) {
  const { clipPath, borderRadius } = silhouetteCss(
    shape,
    modifiers,
    tagOrientation,
    lengthMm,
    widthMm
  );

  // Project hole position from snapshot px → display px so the brass
  // grommet sits exactly above the alpha-punched hole.
  let grommetLeft: number | null = null;
  let grommetTop: number | null = null;
  let grommetR: number | null = null;
  if (hole && snapshotDims.w > 0 && snapshotDims.h > 0) {
    const sx = displayDims.w / snapshotDims.w;
    const sy = displayDims.h / snapshotDims.h;
    grommetLeft = hole.cx * sx;
    grommetTop = hole.cy * sy;
    grommetR = hole.r * ((sx + sy) / 2);
  }

  return (
    <div
      aria-label={label}
      className="absolute inset-0"
      style={{
        backfaceVisibility: "hidden",
        transform: isBack ? "rotateY(180deg)" : undefined,
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
      </div>

      {/* Brass grommet — placed AFTER the clipped card so it draws on top
          of the punched hole. The PNG already has alpha-zero at the
          hole's centre; the grommet fills it with photoreal eyelet. */}
      {grommetLeft != null && grommetTop != null && grommetR != null && (
        <BrassGrommet
          left={grommetLeft}
          top={grommetTop}
          radius={grommetR}
          uid={label.toLowerCase()}
        />
      )}
    </div>
  );
}

/**
 * Photoreal brass grommet — a true annulus. The centre is a real SVG
 * hole (carved out via a `<mask>`), not a fill, so whatever sits behind
 * the modal (the dark backdrop, or in the future a twine strand) shows
 * straight through it — visually reading as a physical eyelet you can
 * pass a thread through.
 */
function BrassGrommet({
  left,
  top,
  radius,
  uid,
}: {
  left: number;
  top: number;
  radius: number;
  uid: string;
}) {
  // Outer eyelet ~1.7× the punched hole; inner hole sized at the
  // alpha-punched radius so the grommet rim sits flush.
  const outerR = radius * 1.7;
  const innerR = radius * 0.95;
  const size = outerR * 2;
  // Unique IDs so multiple grommets on the page don't collide.
  const ringId = `brassRing-${uid}`;
  const maskId = `grommetMask-${uid}`;
  const innerShadowId = `grommetInnerShadow-${uid}`;
  return (
    <svg
      aria-hidden
      className="absolute pointer-events-none"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        left: left - outerR,
        top: top - outerR,
        filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.55))",
      }}
    >
      <defs>
        <radialGradient
          id={ringId}
          cx="50%"
          cy="40%"
          r="55%"
          fx="50%"
          fy="32%"
        >
          <stop offset="0%" stopColor="#ffe7a0" />
          <stop offset="32%" stopColor="#e0b25b" />
          <stop offset="62%" stopColor="#a87826" />
          <stop offset="100%" stopColor="#5b3f12" />
        </radialGradient>
        {/* Mask carves the inner circle out of the brass disc so the
            grommet is a TRUE annulus — the centre is transparent in SVG
            terms, not just filled with "transparent" colour. */}
        <mask id={maskId}>
          <rect width={size} height={size} fill="white" />
          <circle cx={outerR} cy={outerR} r={innerR} fill="black" />
        </mask>
        <radialGradient id={innerShadowId} cx="50%" cy="50%" r="50%">
          <stop offset="65%" stopColor="rgba(0,0,0,0)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.6)" />
        </radialGradient>
      </defs>
      {/* Brass annulus — outer disc with the inner circle masked out. */}
      <circle
        cx={outerR}
        cy={outerR}
        r={outerR}
        fill={`url(#${ringId})`}
        mask={`url(#${maskId})`}
      />
      {/* Soft inner shadow around the hole rim — sells the depth. */}
      <circle
        cx={outerR}
        cy={outerR}
        r={innerR + outerR * 0.04}
        fill="none"
        stroke={`url(#${innerShadowId})`}
        strokeWidth={outerR * 0.07}
      />
      {/* Top-left rim highlight — warm crescent simulating overhead light. */}
      <path
        d={`M ${outerR - outerR * 0.7} ${outerR - outerR * 0.45} A ${outerR * 0.85} ${outerR * 0.85} 0 0 1 ${outerR + outerR * 0.55} ${outerR - outerR * 0.6}`}
        fill="none"
        stroke="rgba(255,238,180,0.85)"
        strokeWidth={outerR * 0.07}
        strokeLinecap="round"
      />
      {/* Crisp inner edge — defines the hole's circumference. */}
      <circle
        cx={outerR}
        cy={outerR}
        r={innerR}
        fill="none"
        stroke="rgba(0,0,0,0.55)"
        strokeWidth={Math.max(1, outerR * 0.05)}
      />
    </svg>
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
  const pctX = (mm: number) =>
    (Math.max(0, Math.min(mm, maxModMm)) / Math.max(1, lengthMm)) * 100;
  const pctY = (mm: number) =>
    (Math.max(0, Math.min(mm, maxModMm)) / Math.max(1, widthMm)) * 100;

  switch (shape) {
    case "round-corners": {
      const rx = pctX(modifiers.cornerRadiusMm).toFixed(2);
      const ry = pctY(modifiers.cornerRadiusMm).toFixed(2);
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
      const cx = pctX(modifiers.slantLengthMm).toFixed(2);
      const cy = pctY(modifiers.slantLengthMm).toFixed(2);
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
      const dMm = Math.max(
        0,
        Math.min(modifiers.slantLengthMm, lengthMm * 0.35)
      );
      return { clipPath: flaredClipPolygon(dMm, lengthMm, widthMm, pctX, pctY) };
    }
    case "mixed-cut-round": {
      const cMm = Math.max(
        0,
        Math.min(modifiers.slantLengthMm, maxModMm)
      );
      return {
        clipPath: mixedCutRoundClipPolygon(cMm, lengthMm, widthMm, pctX, pctY),
      };
    }
    default:
      return {};
  }
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
  pctY: (mm: number) => number
): string {
  const d = Math.max(0, Math.min(dMm, lengthMm * 0.35));
  const steps = 10;
  const pts: string[] = ["0% 0%", "100% 0%"];
  // Right side curve (top-right → bottom-right), quadratic Bezier
  // P0=(w,0), P1=(w-d, h/2), P2=(w,h) → x(t) = w - 2(1-t)t*d, y(t) = h*t
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const xMm = lengthMm - 2 * (1 - t) * t * d;
    const yMm = widthMm * t;
    pts.push(`${pctX(xMm).toFixed(3)}% ${pctY(yMm).toFixed(3)}%`);
  }
  pts.push("100% 100%", "0% 100%");
  // Left side curve (bottom-left → top-left), mirror
  // P0=(0,h), P1=(d, h/2), P2=(0,0) → x(t) = 2(1-t)t*d, y(t) = h(1-t)
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
  pctY: (mm: number) => number
): string {
  const c = Math.max(0, Math.min(cMm, lengthMm * 0.4, widthMm * 0.4));
  const steps = 8;
  const pts: string[] = [
    `${pctX(c).toFixed(3)}% 0%`,
    `${pctX(lengthMm - c).toFixed(3)}% 0%`,
    `100% ${pctY(c).toFixed(3)}%`,
    `100% ${pctY(widthMm - c).toFixed(3)}%`,
  ];
  // BR rounded: arc from (w, h-c) to (w-c, h), centre (w-c, h-c), 0 → π/2
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
  // BL rounded: arc from (c, h) to (0, h-c), centre (c, h-c), π/2 → π
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
