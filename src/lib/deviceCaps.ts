/**
 * Device capability probes used to gate MOBILE-ONLY memory guards.
 *
 * The interactive Fabric canvas is a 2000×2000 logical stage. With Fabric's
 * default `enableRetinaScaling`, the lower + upper canvases each allocate a
 * backing store of `2000·dpr × 2000·dpr` — on a dpr-3 iPhone that's
 * 6000×6000×4B = 144 MB EACH (≈288 MB total), which blows past WebKit's
 * per-tab canvas budget and crashes the tab. Capping retina scaling on
 * touch/mobile devices keeps the backing store at 2000×2000 (≈16 MB each).
 *
 * These probes are gated to touch/mobile ONLY so desktop — including Retina
 * Macs — keeps full-resolution rendering and print exports untouched.
 */

let cached: boolean | null = null;

/**
 * True on phones / tablets / touch devices (where the high-DPR backing-store
 * allocation is the crash risk). Memoised — device class doesn't change at
 * runtime. Safe during SSR / non-browser (returns false).
 */
export function isTouchLikeDevice(): boolean {
  if (cached !== null) return cached;
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  try {
    const ua = /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent || "");
    const mm = typeof window.matchMedia === "function" ? window.matchMedia : null;
    // PRIMARY input is touch: a phone/tablet reports `(pointer: coarse)` and
    // NOT `(pointer: fine)`. A touchscreen DESKTOP/laptop reports a FINE
    // primary pointer (mouse/trackpad) even though it also has touch, so it
    // must stay on the desktop (full-Retina) path — hence the `!fine` guard.
    // `navigator.maxTouchPoints` alone is NOT used: it flags those desktops.
    const coarsePrimary =
      !!mm &&
      mm("(pointer: coarse)").matches &&
      !mm("(pointer: fine)").matches;
    // iPadOS 13+ masquerades as desktop Safari (no mobile UA) but has a
    // coarse-only primary pointer, so `coarsePrimary` catches it.
    cached = !!(ua || coarsePrimary);
  } catch {
    cached = false;
  }
  return cached;
}

/** The device's raw pixel ratio (defaults to 1 off-browser). */
export function devicePixelRatioSafe(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}
