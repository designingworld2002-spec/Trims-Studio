import { fabric } from "fabric";

/**
 * Fabric.js IText/Textbox creates a hidden <textarea> that captures keyboard
 * input when the user enters edit mode. Its position is computed in canvas
 * coordinates — but the editor wraps the canvas in a CSS-scaled div, so
 * fabric's coordinates don't match the actual on-screen position. The
 * textarea ends up far outside the viewport, the browser auto-scrolls to
 * bring the focused element into view, and the entire layout breaks
 * (sometimes irrecoverably — the user reported a "violent scroll" + WSOD).
 *
 * Fix: monkey-patch BOTH `initHiddenTextarea` (creates the element) and
 * `updateTextareaPosition` (called on every keystroke) so the textarea is
 * always pinned to the viewport corner with `position: fixed`. It's
 * invisible (opacity 0); we only need it for keyboard capture, so its
 * on-screen location is irrelevant.
 *
 * Run this once at module load, before any IText is constructed.
 */

let installed = false;

const PINNED_STYLES: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  top: "0px",
  left: "0px",
  width: "1px",
  height: "1px",
  opacity: "0",
  pointerEvents: "none",
  zIndex: "-1",
  transform: "none",
};

function pinTextarea(ta: HTMLTextAreaElement) {
  Object.assign(ta.style, PINNED_STYLES);
}

export function installFabricTextareaFix() {
  if (installed) return;
  installed = true;

  // Fabric 5.3 dropped the underscore from `initHiddenTextarea`; older
  // builds and Textbox descendants still use the underscored variant.
  // Patch every method we can find.
  const protos: any[] = [
    (fabric as any).IText?.prototype,
    (fabric as any).Textbox?.prototype,
  ].filter(Boolean);

  const initMethodNames = ["initHiddenTextarea", "_initHiddenTextarea"];
  const updateMethodNames = ["updateTextareaPosition"];

  protos.forEach((proto) => {
    initMethodNames.forEach((name) => {
      const original = proto[name];
      if (typeof original !== "function") return;
      proto[name] = function patched(this: any) {
        const result = original.apply(this, arguments);
        if (this.hiddenTextarea) pinTextarea(this.hiddenTextarea);
        return result;
      };
    });

    updateMethodNames.forEach((name) => {
      const original = proto[name];
      if (typeof original !== "function") return;
      proto[name] = function patched(this: any) {
        // Skip fabric's positioning math entirely — we don't want it
        // moving the textarea off-screen. Keystrokes still arrive because
        // the textarea remains focused; cursor visuals are drawn by fabric
        // on the canvas, not via the textarea position.
        if (this.hiddenTextarea) pinTextarea(this.hiddenTextarea);
      };
    });
  });
}
