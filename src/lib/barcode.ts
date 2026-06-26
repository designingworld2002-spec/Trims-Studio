/**
 * Shared barcode URL builder for the bwip-js public API.
 *
 * Both the "Add a barcode" modal and the recolour action in the store
 * call this so the generated URL is consistent. The API expects hex
 * colours WITHOUT the leading `#`. Omitting `backgroundcolor` yields a
 * transparent background.
 *
 * Docs: https://bwip-js.metafloor.com/  (HTTP API at bwipjs-api.metafloor.com)
 */
export function buildBarcodeApiUrl(
  text: string,
  opts?: { barColor?: string; bgColor?: string; hasBg?: boolean }
): string {
  const barColor = (opts?.barColor ?? "#000000").replace(/^#/, "");
  const hasBg = opts?.hasBg !== false;
  const bgColor = (opts?.bgColor ?? "#ffffff").replace(/^#/, "");

  const params = new URLSearchParams({
    bcid: "code128",
    text,
    scale: "3",
    height: "12",
    includetext: "true",
    textxalign: "center",
    // `barcolor` colours both the bars and the human-readable caption.
    barcolor: barColor,
  });
  // Only set a background when the user wants one — otherwise the PNG is
  // transparent so the tag/label colour shows through behind the bars.
  if (hasBg) {
    params.set("backgroundcolor", bgColor);
  }
  return `https://bwipjs-api.metafloor.com/?${params.toString()}`;
}
