import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useCanvasStore } from "./store/canvasStore";
import { readUrlConfig } from "./lib/urlParams";
import { getProductConfig } from "./config/productConfig";
import { installFabricTextareaFix } from "./lib/fabricTextareaFix";
import "./index.css";

// Pin fabric's hidden IText textarea to the viewport corner so the browser
// never auto-scrolls when text editing begins under our CSS-scaled canvas.
installFabricTextareaFix();

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
