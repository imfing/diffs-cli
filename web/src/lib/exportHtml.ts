import type { DiffsThemeNames, FileDiffMetadata, ThemesType, ThemeTypes } from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import jetbrainsMono400Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import jetbrainsMono700Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url";
import interVariableUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import { DIFF_SURFACE_FONT_SIZE } from "@/lib/diffTypography";
import { DEFAULT_CODE_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, prependFontFamily } from "@/lib/fonts";

// Subset of @pierre/diffs render options that affect static rasterization; mirrors the
// live CodeView `options` (a superset object is accepted).
export interface ExportDiffOptions {
  theme: DiffsThemeNames | ThemesType;
  themeType: ThemeTypes | undefined;
  diffStyle: "split" | "unified";
  disableBackground: boolean;
  disableLineNumbers: boolean;
  overflow: "scroll" | "wrap";
}

export interface ExportDiffParams {
  files: readonly FileDiffMetadata[];
  options: ExportDiffOptions;
  title: string;
  subtitle?: string;
  // Locks the page shell to dark/light; the diff theme is baked in independently.
  dark: boolean;
  fileName: string;
  codeFontFamily?: string;
  uiFontFamily?: string;
}

// Fonts are inlined as base64 so the export renders offline; fetched lazily and cached for the session.
let fontFaceCssPromise: Promise<string> | null = null;

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchFontDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return `data:font/woff2;base64,${bufferToBase64(buffer)}`;
}

async function buildFontFaceCss(): Promise<string> {
  const [mono400, mono700, inter] = await Promise.all([
    fetchFontDataUrl(jetbrainsMono400Url),
    fetchFontDataUrl(jetbrainsMono700Url),
    fetchFontDataUrl(interVariableUrl),
  ]);
  return [
    `@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;font-display:swap;src:url(${mono400}) format("woff2");}`,
    `@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:700;font-display:swap;src:url(${mono700}) format("woff2");}`,
    `@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;font-display:swap;src:url(${inter}) format("woff2");}`,
  ].join("");
}

function getFontFaceCss(): Promise<string> {
  if (fontFaceCssPromise == null) {
    fontFaceCssPromise = buildFontFaceCss().catch((err) => {
      // Reset so a later export can retry; fall back to system fonts this time.
      fontFaceCssPromise = null;
      console.error("Failed to inline fonts for export:", err);
      return "";
    });
  }
  return fontFaceCssPromise;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Preloaded fragments share identical sprite/style blocks across files; split and dedupe to
// avoid bloating the document.
interface SplitFragment {
  styles: string[];
  sprite: string | null;
  content: string;
}

function splitFragment(html: string): SplitFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const styles: string[] = [];
  let sprite: string | null = null;
  const content: string[] = [];
  for (const element of template.content.children) {
    const tag = element.tagName.toLowerCase();
    if (tag === "style") {
      styles.push(element.outerHTML);
    } else if (tag === "svg" && sprite == null) {
      sprite = element.outerHTML;
    } else {
      content.push(element.outerHTML);
    }
  }
  return { styles, sprite, content: content.join("") };
}

// Shell CSS + design tokens; mirrors web/src/index.css palette — keep roughly in sync if that changes.
const SHELL_CSS = `
:root{
  color-scheme:light;
  --bg:#ffffff;
  --fg:#171717;
  --muted-fg:#737373;
  --border:#e5e5e5;
  --surface:#fafafa;
}
.dark{
  color-scheme:dark;
  --bg:#0a0a0a;
  --fg:#fafafa;
  --muted-fg:#a3a3a3;
  --border:#262626;
  --surface:#171717;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{
  background:var(--bg);
  color:var(--fg);
  font-family:var(--font-sans);
  -webkit-font-smoothing:antialiased;
}
.export-header{
  padding:16px 20px;
  border-bottom:1px solid var(--border);
  background:var(--surface);
}
.export-header h1{
  margin:0;
  font-size:15px;
  font-weight:600;
  line-height:1.3;
  word-break:break-word;
}
.export-header p{
  margin:4px 0 0;
  font-size:12px;
  color:var(--muted-fg);
  word-break:break-word;
}
.export-main{
  padding:16px 20px 48px;
}
.diffs-root{
  display:block;
}
`.trim();

// Mirrors applyConfigFontFamilies; values inherit across the shadow boundary. Note:
// --diffs-header-font-family is left unset on purpose to match the live app's fallback.
function fontVarsCss(codeFontFamily: string | undefined, uiFontFamily: string | undefined): string {
  const code =
    prependFontFamily(codeFontFamily, DEFAULT_CODE_FONT_FAMILY) ?? DEFAULT_CODE_FONT_FAMILY;
  const ui = prependFontFamily(uiFontFamily, DEFAULT_UI_FONT_FAMILY) ?? DEFAULT_UI_FONT_FAMILY;
  return `:root{--font-sans:${ui};}.diffs-root{--diffs-font-family:${code};--diffs-font-size:${DIFF_SURFACE_FONT_SIZE};}`;
}

// Injected inside the shadow root; --border inherits across the shadow boundary
// alongside the library's :host-scoped styles.
const SHADOW_LAYOUT_CSS = `<style>
.diffs-file{margin:0 0 16px;border:1px solid var(--border);border-radius:8px;overflow:hidden;}
.diffs-file:last-child{margin-bottom:0;}
</style>`;

async function buildDocument(params: ExportDiffParams): Promise<string> {
  const { files, options, title, subtitle, dark, codeFontFamily, uiFontFamily } = params;
  // Explicit allowlist, not `{ ...options }` — options is the live codeViewOptions and also
  // carries callbacks/layout that would alter the static render if spread.
  const renderOptions = {
    theme: options.theme,
    themeType: options.themeType,
    diffStyle: options.diffStyle,
    disableBackground: options.disableBackground,
    disableLineNumbers: options.disableLineNumbers,
    overflow: options.overflow,
    hunkSeparators: "line-info" as const,
  };

  const [fontFaceCss, fragments] = await Promise.all([
    getFontFaceCss(),
    Promise.all(files.map((fileDiff) => preloadFileDiff({ fileDiff, options: renderOptions }))),
  ]);

  // Diff styles are :host-scoped; content must live in a real shadow root or theme colors are
  // dropped. A declarative shadow root does this with no runtime JS and enables dedup.
  const styleSet = new Set<string>();
  let sprite: string | null = null;
  const fileBlocks: string[] = [];
  for (const fragment of fragments) {
    const { styles, sprite: fragmentSprite, content } = splitFragment(fragment.prerenderedHTML);
    for (const style of styles) styleSet.add(style);
    if (sprite == null) sprite = fragmentSprite;
    fileBlocks.push(`<div class="diffs-file">${content}</div>`);
  }

  const shadowContent = [
    sprite ?? "",
    [...styleSet].join(""),
    SHADOW_LAYOUT_CSS,
    fileBlocks.join(""),
  ].join("");

  const subtitleHtml = subtitle && subtitle.trim() !== "" ? `<p>${escapeHtml(subtitle)}</p>` : "";

  return `<!doctype html>
<html lang="en"${dark ? ' class="dark"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${fontFaceCss}${SHELL_CSS}${fontVarsCss(codeFontFamily, uiFontFamily)}</style>
</head>
<body>
<header class="export-header"><h1>${escapeHtml(title)}</h1>${subtitleHtml}</header>
<main class="export-main">
<div class="diffs-root"><template shadowrootmode="open">${shadowContent}</template></div>
</main>
</body>
</html>`;
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "diff" : cleaned;
}

function triggerDownload(html: string, fileName: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sanitizeFileName(fileName)}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportDiffToHtml(params: ExportDiffParams): Promise<void> {
  const html = await buildDocument(params);
  triggerDownload(html, params.fileName);
}
