export type AppColorScheme = "dark" | "light" | "system";
export type ResolvedColorScheme = "dark" | "light";

export const colorSchemeStorageKey = "diffs-color-scheme";

const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function isAppColorScheme(value: unknown): value is AppColorScheme {
  return value === "dark" || value === "light" || value === "system";
}

export function storedColorScheme(): AppColorScheme | null {
  const stored = localStorage.getItem(colorSchemeStorageKey);
  return isAppColorScheme(stored) ? stored : null;
}

export function initialColorScheme(): AppColorScheme {
  return storedColorScheme() ?? "system";
}

export function resolveColorScheme(preference: AppColorScheme): ResolvedColorScheme {
  return preference === "dark" || (preference === "system" && colorSchemeQuery.matches)
    ? "dark"
    : "light";
}

export function applyColorScheme(preference: AppColorScheme) {
  const dark = resolveColorScheme(preference) === "dark";
  document.documentElement.dataset.colorScheme = preference;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function persistColorScheme(preference: AppColorScheme) {
  localStorage.setItem(colorSchemeStorageKey, preference);
}

export function watchSystemColorScheme(onChange?: (scheme: ResolvedColorScheme) => void) {
  const listener = () => {
    onChange?.(resolveColorScheme("system"));
    const current = document.documentElement.dataset.colorScheme;
    if (current === "system") applyColorScheme("system");
  };
  colorSchemeQuery.addEventListener("change", listener);
  return () => colorSchemeQuery.removeEventListener("change", listener);
}
