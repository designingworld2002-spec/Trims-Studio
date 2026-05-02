/**
 * Curated font list shown in the font picker.
 *
 * The Google webfonts in this list are loaded via the `<link>` tag in
 * index.html with `display=swap`, so they fall back to a system font
 * until the webfont arrives.
 *
 * Each entry has:
 *  - `family`: the exact CSS `font-family` value (must match what fabric
 *    saves in the JSON, otherwise round-tripping fonts breaks).
 *  - `category`: drives optional grouping in the picker UI.
 *  - `system`: true for fonts that ship with the OS, so we don't need a
 *    webfont request.
 */

export type FontCategory =
  | "system"
  | "sans"
  | "serif"
  | "display"
  | "handwriting"
  | "mono";

export interface FontDef {
  family: string;
  category: FontCategory;
  system?: boolean;
}

export const FONTS: FontDef[] = [
  // System (no network)
  { family: "Arial", category: "system", system: true },
  { family: "Helvetica", category: "system", system: true },
  { family: "Georgia", category: "system", system: true },
  { family: "Times New Roman", category: "system", system: true },
  { family: "Courier New", category: "system", system: true },
  // Google sans
  { family: "Inter", category: "sans" },
  { family: "Roboto", category: "sans" },
  { family: "Open Sans", category: "sans" },
  { family: "Lato", category: "sans" },
  { family: "Montserrat", category: "sans" },
  { family: "Poppins", category: "sans" },
  { family: "Raleway", category: "sans" },
  { family: "Nunito", category: "sans" },
  { family: "Oswald", category: "sans" },
  { family: "Bebas Neue", category: "display" },
  // Google serif
  { family: "Playfair Display", category: "serif" },
  { family: "Merriweather", category: "serif" },
  { family: "Lora", category: "serif" },
  { family: "PT Serif", category: "serif" },
  { family: "EB Garamond", category: "serif" },
  // Display + handwriting
  { family: "Pacifico", category: "handwriting" },
  { family: "Dancing Script", category: "handwriting" },
  { family: "Caveat", category: "handwriting" },
  { family: "Permanent Marker", category: "handwriting" },
  { family: "Anton", category: "display" },
  // Mono
  { family: "Roboto Mono", category: "mono" },
];

export const DEFAULT_FONT_FAMILY = "Inter";
