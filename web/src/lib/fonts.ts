// Default font stacks shared by the live diff view and the HTML export so the
// two stay in sync. The first family in each stack is bundled via @fontsource.
export const DEFAULT_UI_FONT_FAMILY = `"Inter Variable", sans-serif`;
export const DEFAULT_CODE_FONT_FAMILY = `"JetBrains Mono", ui-monospace, Consolas, monospace`;

// Prepends a user-configured family ahead of the default stack so it takes
// precedence when available. Returns undefined when no custom family is set, so
// callers can decide whether to clear the property or fall back to the default.
export function prependFontFamily(value: string | undefined, fallback: string): string | undefined {
  const preferred = value?.trim();
  return preferred ? `${preferred}, ${fallback}` : undefined;
}
