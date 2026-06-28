import { useEffect, useLayoutEffect, useState } from "react";
import { useCanvasStore, type ToolKey } from "@/store/canvasStore";

/**
 * Stateful, element-highlighting onboarding tour. No videos — each step
 * spotlights a REAL DOM node (matched by a `data-tour` attribute),
 * darkens everything else with a box-shadow mask, and floats a "cloud
 * comment" tooltip card beside it.
 *
 * Some steps are STATEFUL: they open a specific sidebar tab
 * (`targetTab`) so the tour can explain that tab's sub-features. Because
 * a panel's DOM only exists once its tab is open, the measurement is
 * deliberately async — we switch the tab first, then re-measure across a
 * short settle burst until the new element appears.
 *
 * Targets are resilient: if a step's element can't be found the tour
 * still renders a centred card so the flow never dead-ends.
 */
interface TourStep {
  selector: string;
  title: string;
  description: string;
  /** Sidebar tab to open before highlighting (sub-feature steps). */
  targetTab?: NonNullable<ToolKey>;
}

const STEPS: TourStep[] = [
  {
    selector: '[data-tour="sidebar"]',
    title: "Your toolbox",
    description:
      "Every editing tool lives in this rail — products, text, uploads, graphics and backgrounds. We'll walk through each one.",
  },
  {
    selector: '[data-tour="panel-product"]',
    targetTab: "product",
    title: "Product options",
    description:
      "Set your label's size and orientation, pick a preset, and choose a shape where the product allows it.",
  },
  {
    selector: '[data-tour="panel-text"]',
    targetTab: "text",
    title: "Add text",
    description:
      "Add headings and body text, then restyle font, size, colour and alignment. Selecting text on the canvas opens this tab automatically.",
  },
  {
    selector: '[data-tour="panel-uploads"]',
    targetTab: "uploads",
    title: "Upload images",
    description:
      "Drop in your own logos and artwork. We flag low-resolution images so nothing prints blurry.",
  },
  {
    selector: '[data-tour="panel-background"]',
    targetTab: "background",
    title: "Background & colours",
    description:
      "Fill the label with a solid colour from the swatches, a custom hex, or the colour picker.",
  },
  {
    selector: '[data-tour="canvas"]',
    title: "The design canvas",
    description:
      "This is your label. Drag, resize and arrange elements freely — the dashed guides show the safe print area.",
  },
  {
    selector: '[data-tour="zoom"]',
    title: "Zoom & settings",
    description:
      "Zoom in and out (or scroll the mouse wheel) in 10% steps, reset to 100%, and toggle the print guides.",
  },
  {
    selector: '[data-tour="history"]',
    title: "Undo, redo & help",
    description:
      "Step backward or forward through your changes, and reopen this tour any time from the help icon.",
  },
  {
    selector: '[data-tour="actions"]',
    title: "Preview & continue",
    description:
      "Preview a realistic 3D mock-up of your label, then hit Next to finalise and add it to your order.",
  },
];

const CARD_W = 300;
const CARD_H_EST = 168;
const PAD = 8; // highlight padding around the target
const GAP = 14; // gap between target and card

export function StudioTour() {
  const setTourActive = useCanvasStore((s) => s.setTourActive);
  const openTool = useCanvasStore((s) => s.openTool);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  const end = () => setTourActive(false);
  const next = () => (isLast ? end() : setStepIndex((i) => i + 1));
  const prev = () => setStepIndex((i) => Math.max(0, i - 1));

  // STATEFUL step entry: if the step targets a sidebar tab, open it the
  // moment we arrive at the step. The measure effect below then waits for
  // the panel to mount before highlighting it. Runs on stepIndex change.
  useEffect(() => {
    if (step.targetTab) openTool(step.targetTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // Measure the active target. Event-driven (resize/scroll) plus a SHORT
  // bounded burst of re-measures to catch async layout settle — critically
  // including the tab switch above: the panel's DOM won't exist on the
  // first synchronous measure, so the 150/300/600ms re-measures catch it
  // once React has rendered the newly-opened tab. setRect skips no-op
  // updates so a stable target never churns renders (no perpetual loop).
  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector(step.selector);
      const nextRect = el ? el.getBoundingClientRect() : null;
      setRect((prev) => {
        if (
          prev &&
          nextRect &&
          prev.top === nextRect.top &&
          prev.left === nextRect.left &&
          prev.width === nextRect.width &&
          prev.height === nextRect.height
        ) {
          return prev; // unchanged → no re-render
        }
        if (!prev && !nextRect) return prev;
        return nextRect;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // Bounded settle burst — long enough to outlast the tab-open render
    // + the panel's drawer animation, then stops (no infinite interval).
    const timers = [150, 300, 600, 900].map((ms) =>
      window.setTimeout(measure, ms)
    );
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      timers.forEach((t) => clearTimeout(t));
    };
  }, [step.selector, stepIndex]);

  // Escape ends the tour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  // Padded highlight box (clamped to viewport).
  const hl = rect
    ? {
        top: Math.max(0, rect.top - PAD),
        left: Math.max(0, rect.left - PAD),
        width: Math.min(vw, rect.width + PAD * 2),
        height: Math.min(vh, rect.height + PAD * 2),
      }
    : null;

  // Choose the side with the most room; clamp fully on-screen.
  const cardPos = (() => {
    if (!hl) {
      return { left: (vw - CARD_W) / 2, top: (vh - CARD_H_EST) / 2 };
    }
    const clampLeft = (l: number) =>
      Math.max(12, Math.min(l, vw - CARD_W - 12));
    const clampTop = (t: number) =>
      Math.max(12, Math.min(t, vh - CARD_H_EST - 12));

    const spaceRight = vw - (hl.left + hl.width);
    const spaceLeft = hl.left;
    const spaceBelow = vh - (hl.top + hl.height);

    // Prefer right, then left, then below, then above.
    if (spaceRight >= CARD_W + GAP) {
      return {
        left: hl.left + hl.width + GAP,
        top: clampTop(hl.top),
      };
    }
    if (spaceLeft >= CARD_W + GAP) {
      return { left: hl.left - CARD_W - GAP, top: clampTop(hl.top) };
    }
    if (spaceBelow >= CARD_H_EST + GAP) {
      return { left: clampLeft(hl.left), top: hl.top + hl.height + GAP };
    }
    return { left: clampLeft(hl.left), top: clampTop(hl.top - CARD_H_EST - GAP) };
  })();

  return (
    <div className="fixed inset-0 z-[200]" aria-modal="true" role="dialog">
      {/* Click-swallowing backdrop (kept transparent — the highlight box
          paints the dark mask via its huge box-shadow). */}
      <div className="absolute inset-0" onClick={() => {}} />

      {/* Spotlight — its box-shadow darkens the entire viewport EXCEPT
          this rect. pointer-events:none so it's purely visual. */}
      {hl && (
        <div
          className="absolute rounded-xl ring-2 ring-white/80 transition-all duration-200 pointer-events-none"
          style={{
            top: hl.top,
            left: hl.left,
            width: hl.width,
            height: hl.height,
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.62)",
          }}
        />
      )}
      {/* No target found → still dim the whole screen so the card reads. */}
      {!hl && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "rgba(15, 23, 42, 0.62)" }}
        />
      )}

      {/* Cloud-comment tooltip card. */}
      <div
        className="absolute bg-white rounded-2xl shadow-2xl border border-vp-border p-5 flex flex-col gap-3"
        style={{ left: cardPos.left, top: cardPos.top, width: CARD_W }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-vp-blue">
            Step {stepIndex + 1} of {STEPS.length}
          </span>
          <button
            type="button"
            onClick={end}
            className="text-[11px] font-medium text-vp-muted hover:text-vp-ink transition-colors"
          >
            End tour
          </button>
        </div>

        <div>
          <h3 className="text-[15px] font-semibold text-vp-ink leading-snug">
            {step.title}
          </h3>
          <p className="mt-1 text-[13px] text-vp-ink/70 leading-relaxed">
            {step.description}
          </p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={[
                "h-1.5 rounded-full transition-all",
                i === stepIndex ? "w-5 bg-vp-blue" : "w-1.5 bg-vp-border",
              ].join(" ")}
            />
          ))}
        </div>

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={prev}
            disabled={isFirst}
            className="h-9 px-4 rounded-full text-[13px] font-semibold text-vp-ink/70 hover:bg-vp-rail disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={next}
            className="h-9 px-5 rounded-full bg-vp-blue hover:bg-vp-blue-hover text-white text-[13px] font-semibold shadow-sm transition-colors"
          >
            {isLast ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
