import React from "react";
import ReactDOM from "react-dom/client";
import { fabric } from "fabric";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useCanvasStore } from "./store/canvasStore";
import { readUrlConfig } from "./lib/urlParams";
import { getProductConfig } from "./config/productConfig";
import { installFabricTextareaFix } from "./lib/fabricTextareaFix";
import { installFabricControlDefaults } from "./lib/fabricControlDefaults";
import { isTouchLikeDevice } from "./lib/deviceCaps";
import { normaliseMaterial } from "./lib/pricing";
import "./index.css";

// ── iOS / mobile memory guard: cap Fabric's object-cache allocations ──────
// Fabric caches each object to an offscreen canvas bounded by
// `maxCacheSideLimit` (default 4096) and `perfLimitSizeTotal` (default
// 2,097,152 px). On touch devices a single large text/image object can
// otherwise allocate a multi-MB offscreen cache; halving these keeps mobile
// memory in check. Desktop keeps Fabric's defaults (full quality) untouched.
if (isTouchLikeDevice()) {
  (fabric as any).perfLimitSizeTotal = 1048576; // 1024×1024 px cap
  (fabric as any).maxCacheSideLimit = 2048;
}

/** Products whose size + material must be chosen before designing. */
const MATERIAL_SETUP_HANDLES = ["washcare-labels", "size-labels"];

// Pin fabric's hidden IText textarea to the viewport corner so the browser
// never auto-scrolls when text editing begins under our CSS-scaled canvas.
installFabricTextareaFix();

// High-contrast selection handles so the resize controls (corners/borders)
// stay visible on ANY canvas background colour.
installFabricControlDefaults();

/* Seed the store from URL params BEFORE React mounts.
 *
 * Otherwise child effects (Workspace's canvas + autosave init) fire before
 * the parent effect (App's URL reader) — that race condition makes the
 * autosave generate a fresh workId on every reload, defeating resume.
 */
{
  // Resolve the active product config FIRST so the URL parser can fall
  // back to the right default dimensions when length/width are omitted.
  const productHandle = new URLSearchParams(window.location.search).get(
    "product"
  );
  const productConfig = getProductConfig(productHandle);

  const cfg = readUrlConfig(productConfig.defaultDimensions);
  const s = useCanvasStore.getState();
  s.setProductConfig(productConfig);
  // setCanvasSize applies the product's hard dimension constraints, so a
  // URL carrying an impossible size (e.g. ?product=printed-ribbons with
  // length=90&width=70) still boots onto a makeable canvas (150 x 50 mm).
  s.setCanvasSize(cfg.lengthMm, cfg.widthMm);
  // Template mode is always locked; upload mode starts locked but the user
  // can break the link via the chain icon in the Product Options panel.
  s.setAspectRatioLocked(true);
  s.setProductTitle(cfg.title);
  s.setProductSlug(cfg.productSlug);
  s.setMode(cfg.mode);
  s.setWorkId(cfg.workId);
  s.setCustomerId(cfg.customerId);
  s.setTemplateMeta({
    id: cfg.templateId,
    name: cfg.templateName,
    imageUrl: cfg.templateImageUrl,
    jsonUrl: cfg.templateJsonUrl,
  });
  if (cfg.autoOpenUpload) {
    // Centered modal (Vistaprint-style) instead of just opening the
    // sidebar — gives the user a clearer first-touch experience.
    s.setUploadModalOpen(true);
    s.setActiveTool("uploads");
  }

  // ── Material ────────────────────────────────────────────────────────────
  // First-match-wins chain: an explicit `?material=` wins when it carries a
  // real material hint; otherwise (missing, empty, or malformed) we fall
  // THROUGH to the product handle (cotton-printed-labels → Cotton, …), and
  // only default to Woven when nothing matches. Washcare / size labels don't
  // imply a material, so they get the setup modal instead.
  const materialParam = new URLSearchParams(window.location.search).get(
    "material"
  );
  // `defaultMaterial` is the last link in the chain: it rescues printed
  // products whose handle names no fabric (printed-ribbons -> Satin) from
  // falling through to the Woven formula.
  s.setMaterial(
    normaliseMaterial(
      materialParam,
      productConfig.handle,
      productConfig.defaultMaterial
    )
  );

  if (
    !materialParam &&
    MATERIAL_SETUP_HANDLES.includes(productConfig.handle)
  ) {
    s.setMaterialSetupOpen(true);
  }

  // Snapshot the boot URL so the "Revert to original template" pill can
  // restore it after a Recent Designs load.
  s.setOriginalUrlSearch(window.location.search);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
