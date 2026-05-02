import { useEffect } from "react";
import { fabric } from "fabric";

const VIRTUAL_SIZE = 2000;

const GUIDE_ID = "smart-guide";

/** Snap distance in canvas (= virtual) pixels. */
const THRESHOLD = 6;
const GUIDE_STROKE = "#00fa9a";

/**
 * Smart alignment guides for fabric.js, mimicking the Vistaprint / Canva
 * dragging experience.
 *
 * Behaviour:
 *   • While the user drags an object, the hook compares its bounding-box
 *     edges and centre against:
 *       - the canvas centre (X and Y)
 *       - every other user object's edges and centre
 *     If any pair is within THRESHOLD px, the moving object is snapped
 *     to the exact alignment and a temporary green guide line is drawn
 *     across the canvas at the matched coordinate.
 *   • Guides are removed on `mouse:up` and on `selection:cleared` so they
 *     never linger after the drag ends.
 *
 * Exclusions (snap targets AND draw set):
 *   • Bleed rectangle (id "bleed")
 *   • Safety rectangle (id "safety")
 *   • Template background (id "templateBg")
 *   • The guides themselves (id "smart-guide")
 *   • Any object with `excludeFromExport: true`
 *
 * The drawn guides have `excludeFromExport: true` so they never appear in
 * `canvas.toJSON()` output, and the upgraded HistoryManager filter means
 * they don't trigger snapshot pollution either.
 */
export function useSmartGuides(canvas: fabric.Canvas | null) {
  useEffect(() => {
    if (!canvas) return;

    const isExcludedFromSnapping = (o: fabric.Object): boolean => {
      const id = (o as any).id;
      return (
        (o as any).excludeFromExport === true ||
        id === "bleed" ||
        id === "safety" ||
        id === "templateBg" ||
        id === GUIDE_ID
      );
    };

    const clearGuides = () => {
      const stale = canvas
        .getObjects()
        .filter((o) => (o as any).id === GUIDE_ID);
      if (stale.length === 0) return;
      canvas.remove(...stale);
      canvas.requestRenderAll();
    };

    const drawVerticalGuide = (x: number) => {
      const line = new fabric.Line([x, 0, x, VIRTUAL_SIZE], {
        stroke: GUIDE_STROKE,
        strokeWidth: 1,
        selectable: false,
        evented: false,
        hoverCursor: "default",
        objectCaching: false,
      });
      (line as any).id = GUIDE_ID;
      (line as any).excludeFromExport = true;
      canvas.add(line);
      canvas.bringToFront(line);
    };

    const drawHorizontalGuide = (y: number) => {
      const line = new fabric.Line([0, y, VIRTUAL_SIZE, y], {
        stroke: GUIDE_STROKE,
        strokeWidth: 1,
        selectable: false,
        evented: false,
        hoverCursor: "default",
        objectCaching: false,
      });
      (line as any).id = GUIDE_ID;
      (line as any).excludeFromExport = true;
      canvas.add(line);
      canvas.bringToFront(line);
    };

    const onMoving = (opt: fabric.IEvent<MouseEvent>) => {
      const obj = opt.target;
      if (!obj || isExcludedFromSnapping(obj)) return;

      // Always start a new frame's worth of guides.
      clearGuides();

      const cx = VIRTUAL_SIZE / 2;
      const cy = VIRTUAL_SIZE / 2;

      // Use the OBJECT'S aCoords-derived bounding rect; pass `true, true`
      // so we get coords in the ABSOLUTE canvas space (independent of
      // group nesting + viewport transform).
      const br = obj.getBoundingRect(true, true);
      const objLeft = br.left;
      const objRight = br.left + br.width;
      const objTop = br.top;
      const objBottom = br.top + br.height;
      const objCx = br.left + br.width / 2;
      const objCy = br.top + br.height / 2;

      // ---- Build candidate snap points ---- //
      // Each entry says "if MY edge X falls within THRESHOLD of some
      // target line at X = lineX, snap so MY edge X equals lineX".
      type XSnap = { mine: number; lineX: number };
      type YSnap = { mine: number; lineY: number };
      const xCandidates: XSnap[] = [
        { mine: objCx, lineX: cx }, // canvas centre vertical
      ];
      const yCandidates: YSnap[] = [
        { mine: objCy, lineY: cy }, // canvas centre horizontal
      ];

      // Other user objects.
      canvas.getObjects().forEach((other) => {
        if (other === obj || isExcludedFromSnapping(other)) return;
        const obr = other.getBoundingRect(true, true);
        const oL = obr.left;
        const oR = obr.left + obr.width;
        const oT = obr.top;
        const oB = obr.top + obr.height;
        const oCx = obr.left + obr.width / 2;
        const oCy = obr.top + obr.height / 2;
        // Vertical alignment opportunities (X axis).
        xCandidates.push(
          { mine: objLeft, lineX: oL }, // left ↔ left
          { mine: objRight, lineX: oR }, // right ↔ right
          { mine: objCx, lineX: oCx }, // centre ↔ centre
          { mine: objLeft, lineX: oR }, // left ↔ right (touching)
          { mine: objRight, lineX: oL } // right ↔ left
        );
        // Horizontal alignment opportunities (Y axis).
        yCandidates.push(
          { mine: objTop, lineY: oT },
          { mine: objBottom, lineY: oB },
          { mine: objCy, lineY: oCy },
          { mine: objTop, lineY: oB },
          { mine: objBottom, lineY: oT }
        );
      });

      // ---- Pick the closest candidate per axis (within threshold) ----
      let bestX: XSnap | null = null;
      let bestXDelta = Infinity;
      for (const c of xCandidates) {
        const d = Math.abs(c.mine - c.lineX);
        if (d <= THRESHOLD && d < bestXDelta) {
          bestX = c;
          bestXDelta = d;
        }
      }
      let bestY: YSnap | null = null;
      let bestYDelta = Infinity;
      for (const c of yCandidates) {
        const d = Math.abs(c.mine - c.lineY);
        if (d <= THRESHOLD && d < bestYDelta) {
          bestY = c;
          bestYDelta = d;
        }
      }

      // ---- Apply snap + draw guide ----
      if (bestX) {
        obj.left = (obj.left ?? 0) + (bestX.lineX - bestX.mine);
        obj.setCoords();
        drawVerticalGuide(bestX.lineX);
      }
      if (bestY) {
        obj.top = (obj.top ?? 0) + (bestY.lineY - bestY.mine);
        obj.setCoords();
        drawHorizontalGuide(bestY.lineY);
      }
    };

    canvas.on("object:moving", onMoving);
    canvas.on("mouse:up", clearGuides);
    canvas.on("selection:cleared", clearGuides);

    return () => {
      canvas.off("object:moving", onMoving as any);
      canvas.off("mouse:up", clearGuides);
      canvas.off("selection:cleared", clearGuides);
      clearGuides();
    };
  }, [canvas]);
}
