// Shared by the live diff view and the HTML export so the two stay in sync.
export const DEFAULT_UI_FONT_FAMILY = `"Inter Variable", sans-serif`;
export const DEFAULT_CODE_FONT_FAMILY = `"JetBrains Mono", ui-monospace, Consolas, monospace`;

export function prependFontFamily(value: string | undefined, fallback: string): string | undefined {
  const preferred = value?.trim();
  return preferred ? `${preferred}, ${fallback}` : undefined;
}
