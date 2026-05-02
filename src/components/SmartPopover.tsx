import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Portal-rendered popover with collision-aware positioning.
 *
 * Why this exists:
 *
 *  1. **Clipping fix.** The canvas-area popovers (Arrange menu, Effects,
 *     font dropdown…) used to render inside their flex parents and got
 *     clipped by `overflow-hidden` ancestors and the bottom zoom bar.
 *     Rendering through a `document.body` portal sidesteps that entirely.
 *
 *  2. **Smart positioning.** We measure the trigger's `getBoundingClientRect()`
 *     and the popover's natural size, then:
 *       - flip ABOVE the trigger if there's not enough room below;
 *       - right-align if there's not enough room on the left.
 *     `maxHeight` is computed from the available vertical space so the
 *     content scrolls before it ever runs off the viewport (critical on
 *     mobile, where the long Arrange menu was being cut off entirely).
 *
 *  3. **Re-position on scroll/resize.** The trigger's screen position can
 *     change as the user scrolls or rotates the device — we listen to
 *     both events and re-measure.
 *
 *  4. **Click-outside + Esc** dismiss come for free.
 */

interface SmartPopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  /** Tailwind classes applied to the popover panel — usually width + padding. */
  className?: string;
  /** Forced placement; `auto` picks based on viewport. Default `auto`. */
  side?: "auto" | "top" | "bottom";
  /** Forced alignment; `auto` picks based on viewport. Default `auto`. */
  align?: "auto" | "start" | "end";
  /** Optional controlled-mode props. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface ComputedPos {
  top: number;
  left: number;
  maxHeight: number;
  ready: boolean;
}

const VIEWPORT_GAP = 8;

export function SmartPopover({
  trigger,
  children,
  className = "",
  side = "auto",
  align = "auto",
  open: controlledOpen,
  onOpenChange,
}: SmartPopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setUncontrolledOpen(next);
  };

  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<ComputedPos>({
    top: 0,
    left: 0,
    maxHeight: 600,
    ready: false,
  });

  /* --- positioning math ------------------------------------------------ */
  const recompute = () => {
    if (!triggerRef.current) return;
    const t = triggerRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Use the panel's natural size; fall back if not yet measured.
    const panel = panelRef.current;
    const panelW = panel?.offsetWidth ?? 224;
    const panelH = panel?.offsetHeight ?? 280;

    // Vertical
    const spaceBelow = vh - t.bottom - VIEWPORT_GAP;
    const spaceAbove = t.top - VIEWPORT_GAP;
    const wantUp =
      side === "top" ||
      (side === "auto" && spaceBelow < panelH && spaceAbove > spaceBelow);
    const top = wantUp
      ? Math.max(VIEWPORT_GAP, t.top - panelH - 4)
      : Math.min(vh - panelH - VIEWPORT_GAP, t.bottom + 4);
    const maxHeight = Math.max(
      120,
      wantUp ? spaceAbove : Math.min(spaceBelow, vh - VIEWPORT_GAP * 2)
    );

    // Horizontal
    const wantRight =
      align === "end" ||
      (align === "auto" && t.left + panelW + VIEWPORT_GAP > vw);
    let left = wantRight ? t.right - panelW : t.left;
    // Final clamp so the panel never escapes the viewport on either side.
    left = Math.max(VIEWPORT_GAP, Math.min(vw - panelW - VIEWPORT_GAP, left));

    setPos({ top, left, maxHeight, ready: true });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos((p) => ({ ...p, ready: false }));
      return;
    }
    // First measurement happens AFTER the panel mounts so we know its size.
    // Run twice: once with fallback dims to mount, then again after layout.
    recompute();
    const id = window.requestAnimationFrame(recompute);
    const onResize = () => recompute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* --- click-outside / Escape ------------------------------------------ */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <div
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="inline-block"
      >
        {trigger}
      </div>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            className={[
              "fixed bg-white rounded-md shadow-vp-pop border border-vp-border z-[9999] overflow-y-auto vp-scroll",
              className,
            ].join(" ")}
            style={{
              top: pos.top,
              left: pos.left,
              maxHeight: pos.maxHeight,
              // Keep the popover invisible for one frame until we've measured —
              // avoids a flash at the wrong corner.
              visibility: pos.ready ? "visible" : "hidden",
            }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
