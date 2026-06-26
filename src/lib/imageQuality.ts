/** Variance below this ⇒ optically blurry / out of focus. */
export const BLUR_VARIANCE_THRESHOLD = 500;

/**
 * Core Laplacian-variance computation over an ALREADY-DECODED image
 * source (an <img> or <canvas> element). Returns `null` when the work
 * can't run (zero dimensions, no 2D context, or a tainted/cross-origin
 * canvas that throws on getImageData).
 *
 * This is the shared kernel behind both `checkImageBlur` (File-based,
 * used by the upload modal) and `analyzeImageElementSharpness`
 * (element-based, used by the canvas `object:added` flagging so that
 * images added from the user's LIBRARY — which arrive as URLs, not
 * Files — are checked too).
 */
function computeVariance(
  source: CanvasImageSource,
  width: number,
  height: number
): number | null {
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch (e) {
    console.warn("[computeVariance] getImageData failed (CORS?):", e);
    return null;
  }
  const grays = new Float32Array(width * height);
  for (let i = 0; i < pixels.length; i += 4) {
    grays[i / 4] =
      0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  }
  const laplacian = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      laplacian[idx] =
        -grays[(y - 1) * width + x] +
        -grays[y * width + (x - 1)] +
        4 * grays[idx] +
        -grays[y * width + (x + 1)] +
        -grays[(y + 1) * width + x];
    }
  }
  let mean = 0;
  for (let i = 0; i < laplacian.length; i++) mean += laplacian[i];
  mean /= laplacian.length;
  let variance = 0;
  for (let i = 0; i < laplacian.length; i++) {
    const d = laplacian[i] - mean;
    variance += d * d;
  }
  return variance / laplacian.length;
}

/**
 * Synchronous blur check over an already-loaded image element (the
 * underlying element of a fabric.Image). Returns `{ isBlurry, variance }`
 * or `null` if the element isn't ready / can't be sampled. Used by the
 * canvas `object:added` path so library-URL images are flagged exactly
 * like file uploads.
 */
export function analyzeImageElementSharpness(
  el: HTMLImageElement | HTMLCanvasElement | null | undefined
):
  | { isBlurry: boolean; variance: number }
  | null {
  if (!el) return null;
  const width =
    (el as HTMLImageElement).naturalWidth || (el as HTMLCanvasElement).width;
  const height =
    (el as HTMLImageElement).naturalHeight ||
    (el as HTMLCanvasElement).height;
  // Downsample very large sources for speed — variance is scale-stable
  // enough for a blur/sharp decision, and we cap work at ~1MP.
  const MAX = 1000;
  const scale = Math.min(1, MAX / Math.max(width || 1, height || 1));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const variance = computeVariance(el, w, h);
  if (variance == null) return null;
  return { isBlurry: variance < BLUR_VARIANCE_THRESHOLD, variance };
}

/**
 * Race-free optical-blur detection.
 *
 * Every byte of work — canvas creation, drawImage, getImageData,
 * grayscale + Laplacian + variance — runs STRICTLY inside the
 * `img.onload` callback. The Promise never resolves before the bitmap
 * is decoded, so the offscreen canvas can't draw a blank image and
 * the variance can't come back as zero from a silent race.
 *
 * Returns `{ isBlurry, variance }`. A variance below the threshold
 * (default 500) is treated as blurry — that's well above the
 * reference's 100 so textured natural photos still trigger when
 * actually out of focus.
 */
export const checkImageBlur = (
  file: File
): Promise<{ isBlurry: boolean; variance: number }> => {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      try {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        const variance = computeVariance(img, width, height);
        URL.revokeObjectURL(url);
        if (variance == null) {
          resolve({ isBlurry: false, variance: 0 });
          return;
        }
        resolve({ isBlurry: variance < BLUR_VARIANCE_THRESHOLD, variance });
      } catch (e) {
        console.warn("[checkImageBlur] crashed:", e);
        URL.revokeObjectURL(url);
        resolve({ isBlurry: false, variance: 0 });
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ isBlurry: false, variance: 0 });
    };

    img.src = url;
  });
};
