import { fabric } from "fabric";

/**
 * High-contrast selection controls for EVERY Fabric object.
 *
 * Fabric's default handles (light corners, a thin border) vanish when the
 * canvas background is a similar colour — e.g. white corners on a white or
 * pale label, or a faint border on a dark one. Overriding the Object prototype
 * ONCE at startup gives white corners with a black stroke plus a black border,
 * so the resize handles stay visible on ANY background colour.
 *
 * Runs before any object is constructed (called from main.tsx, alongside
 * installFabricTextareaFix).
 */

let installed = false;

export function installFabricControlDefaults() {
  if (installed) return;
  installed = true;

  fabric.Object.prototype.set({
    transparentCorners: false,
    cornerColor: "#ffffff",
    cornerStrokeColor: "#000000",
    borderColor: "#000000",
    cornerSize: 10,
    padding: 5,
    cornerStyle: "circle",
  } as Partial<fabric.Object>);

  // Hide Fabric's built-in top rotation handle (`mtr`) globally — the new
  // VistaPrint-style Rotate button below the object replaces it, keeping
  // the top area clear for the Lock / Duplicate / Delete menu. Set on the
  // prototype so every object (and ActiveSelection) inherits it; the
  // store toggles `hasControls` for lock, which still hides ALL handles
  // when locked, so this only affects the unlocked state.
  try {
    (fabric.Object.prototype as any).setControlsVisibility({ mtr: false });
    if ((fabric as any).ActiveSelection) {
      (fabric as any).ActiveSelection.prototype.setControlsVisibility({
        mtr: false,
      });
    }
  } catch {
    /* non-fatal — older Fabric without setControlsVisibility */
  }
}
