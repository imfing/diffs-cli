import type { DiffsThemeNames, FileDiffMetadata, ThemesType, ThemeTypes } from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import jetbrainsMono400Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import jetbrainsMono700Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url";
import interVariableUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import { DEFAULT_CODE_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, prependFontFamily } from "@/lib/fonts";

// The subset of @pierre/diffs render options that affect how a file diff is
// rasterized to static HTML. Mirrors the live CodeView `options` so the export
// matches what the user currently sees (a superset object is accepted).
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
  // Document <title> and the heading shown at the top of the exported page.
  title: string;
  // Optional secondary line under the heading (e.g. repo path / branch).
  subtitle?: string;
  // Locks the page shell (header/background) to dark or light so it matches the
  // app at export time. The diff theme styles are baked in independently.
  dark: boolean;
  // Suggested download filename (without extension).
  fileName: string;
  // User-configured font families (from AppConfig). When set, each is placed
  // ahead of the embedded default stack, so the export honors the configured
  // font on machines that have it installed and falls back to the embedded
  // JetBrains Mono / Inter otherwise.
  codeFontFamily?: string;
  uiFontFamily?: string;
}

// Fonts are inlined as base64 so the exported file renders identically offline,
// with no dependency on the dev server or any CDN. Fetched lazily on first
// export and cached for the session.
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

// Each preloaded fragment is `<svg sprite>` + one or more `<style>` blocks +
// the diff header/content. The sprite and style blocks are identical across
// files (same render options), so split them out and dedupe to avoid bloating
// the document with one copy per file.
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

// CSS for the page shell (header + layout) plus the design tokens the shell
// relies on. The diff content brings its own inlined theme/highlight styles
// (scoped to the shadow root via `:host`). The shell tokens are a minimal,
// self-contained mirror of the app's neutral palette in web/src/index.css —
// keep them roughly in sync if that palette changes.
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

// Font-family custom properties, resolved per export from the user's config to
// mirror the live app's applyConfigFontFamilies: the configured family in front
// of the embedded default. Kept separate from SHELL_CSS because they vary; the
// values inherit across the shadow boundary so the diff content
// (`--diffs-font-family`) picks them up. `--diffs-header-font-family` is left
// unset on purpose — the live app doesn't set it either, so the diff file
// headers keep the library's system-ui fallback in both views.
function fontVarsCss(codeFontFamily: string | undefined, uiFontFamily: string | undefined): string {
  const code =
    prependFontFamily(codeFontFamily, DEFAULT_CODE_FONT_FAMILY) ?? DEFAULT_CODE_FONT_FAMILY;
  const ui = prependFontFamily(uiFontFamily, DEFAULT_UI_FONT_FAMILY) ?? DEFAULT_UI_FONT_FAMILY;
  return `:root{--font-sans:${ui};}.diffs-root{--diffs-font-family:${code};}`;
}

// Style injected inside the shadow root to space out the per-file blocks. The
// border reuses the shell's `--border` token, which inherits across the shadow
// boundary alongside the library's `:host`-scoped styles.
const SHADOW_LAYOUT_CSS = `<style>
.diffs-file{margin:0 0 16px;border:1px solid var(--border);border-radius:8px;overflow:hidden;}
.diffs-file:last-child{margin-bottom:0;}
</style>`;

async function buildDocument(params: ExportDiffParams): Promise<string> {
  const { files, options, title, subtitle, dark, codeFontFamily, uiFontFamily } = params;
  // Explicit allowlist, not `{ ...options }`: `options` is the live
  // `codeViewOptions`, which also carries interaction callbacks and a `layout`
  // that would alter the static render if spread through to preloadFileDiff.
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

  // The diff styles are `:host`-scoped (the library renders inside a web
  // component's shadow root), so the content must live in a real shadow root or
  // `font-size`, `color-scheme`, and the hunk/highlight colors are dropped.
  // A declarative shadow root reproduces that scope with no runtime JS, and a
  // single shared root lets us dedupe the (identical) sprite and style blocks
  // and keeps `<use href="#icon">` references resolvable.
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

// Renders every file diff to a self-contained HTML document (fonts, highlight
// theme, and layout all inlined) and triggers a browser download.
export async function exportDiffToHtml(params: ExportDiffParams): Promise<void> {
  const html = await buildDocument(params);
  triggerDownload(html, params.fileName);
}
