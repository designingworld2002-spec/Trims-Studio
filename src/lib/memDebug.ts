/**
 * `?debug=mem` — on-device memory forensics.
 *
 * Append `?debug=mem` (or `&debug=mem`) to the studio URL and this logs, to
 * the browser console, the exact allocations that matter on iOS WebKit:
 *   - devicePixelRatio + whether the mobile guards engaged
 *   - every <canvas> in the DOM: backing store + MB, and the total
 *   - every LARGE (>=600px) GPU-composited DOM layer (transform / perspective
 *     / preserve-3d / filter / backdrop-filter / will-change) and the MB it
 *     would cost if WebKit rasterised it at layout-size × dpr² — this is the
 *     number that must stay small on mobile after the stage-layer fix
 *   - how many backdrop-filter elements are live
 *
 * It's inert unless the flag is present, so it ships safely. Runs a few
 * times after boot so it catches the canvas + late-mounted overlays.
 */
import { isTouchLikeDevice, devicePixelRatioSafe } from "./deviceCaps";

export function memDebugEnabled(): boolean {
  try {
    return /(^|[?&])debug=mem(\b|&|$)/.test(window.location.search);
  } catch {
    return false;
  }
}

function snapshot() {
  const dpr = devicePixelRatioSafe();
  const canvases = Array.from(document.querySelectorAll("canvas"));
  const canvasRows = canvases.map((c) => ({
    cls: c.className || "(none)",
    backing: `${c.width}x${c.height}`,
    MB: +((c.width * c.height * 4) / 1048576).toFixed(1),
  }));
  const canvasMB = +(
    canvases.reduce((s, c) => s + c.width * c.height * 4, 0) / 1048576
  ).toFixed(1);

  const layers: Array<{ el: string; layout: string; MB: number; triggers: string[] }> = [];
  let backdropCount = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    const cs = getComputedStyle(el);
    const bf =
      (cs.backdropFilter && cs.backdropFilter !== "none") ||
      ((cs as any).webkitBackdropFilter &&
        (cs as any).webkitBackdropFilter !== "none");
    if (bf) backdropCount++;
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const triggers: string[] = [];
    if (cs.transform && cs.transform !== "none" && cs.transform !== "matrix(1, 0, 0, 1, 0, 0)")
      triggers.push("transform");
    if (cs.perspective && cs.perspective !== "none") triggers.push("perspective");
    if (cs.transformStyle === "preserve-3d") triggers.push("preserve-3d");
    if (cs.filter && cs.filter !== "none") triggers.push("filter");
    if (bf) triggers.push("backdrop-filter");
    if (cs.willChange && cs.willChange !== "auto") triggers.push("will-change");
    if (triggers.length && (w >= 600 || h >= 600)) {
      layers.push({
        el: el.tagName.toLowerCase() + "." + String(el.className || "").slice(0, 24),
        layout: `${w}x${h}`,
        MB: +((w * dpr * h * dpr * 4) / 1048576).toFixed(1),
        triggers,
      });
    }
  }
  const layersMB = +layers.reduce((s, l) => s + l.MB, 0).toFixed(1);

  /* eslint-disable no-console */
  console.log(
    `%c[mem] dpr=${dpr} lowGpu=${isTouchLikeDevice()} | canvases=${canvases.length} (${canvasMB} MB) | ` +
      `largeCompositedLayers=${layers.length} (~${layersMB} MB @dpr${dpr}) | backdropFilterEls=${backdropCount}`,
    "color:#0099ff;font-weight:bold"
  );
  console.table(canvasRows);
  if (layers.length) console.table(layers);
  /* eslint-enable no-console */
}

/** Call once from boot; no-op unless `?debug=mem` is present. */
export function installMemDebug(): void {
  if (!memDebugEnabled()) return;
  // Sample after the canvas mounts and again once overlays settle.
  [800, 2500, 5000].forEach((t) => window.setTimeout(snapshot, t));
}
