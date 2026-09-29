import { useCallback, useMemo, useState } from "react";
import { diffThemeOptions } from "./helpers";
import type { AppConfig, DiffOrderBy, DiffOrderDir, DiffStyle } from "./types";

// Allowed values per setting; the first is the default. Storage keys predate
// this hook, so keep them to preserve saved preferences.
const SPEC = {
  diffStyle: { key: "diffs-diff-style", values: ["split", "unified"] as DiffStyle[] },
  orderBy: { key: "diffs-order-by", values: ["path", "changes", "type"] as DiffOrderBy[] },
  orderDir: { key: "diffs-order-dir", values: ["asc", "desc"] as DiffOrderDir[] },
  diffTheme: { key: "diff-theme", values: diffThemeOptions.map((option) => option.id) },
  lineBackgrounds: { key: "diffs-line-backgrounds", values: [true, false] },
  lineNumbers: { key: "diffs-line-numbers", values: [true, false] },
  wordWrap: { key: "diffs-word-wrap", values: [false, true] },
  collapseRemovals: { key: "diffs-collapse-removals", values: [false, true] },
  hideReviewed: { key: "diffs-hide-reviewed", values: [false, true] },
};

export type Settings = { [K in keyof typeof SPEC]: (typeof SPEC)[K]["values"][number] };
export type SetSetting = <K extends keyof Settings>(name: K, value: Settings[K]) => void;

const NAMES = Object.keys(SPEC) as (keyof Settings)[];

// Server-config defaults, read by property so renaming an AppConfig field fails
// to compile here instead of silently dropping the config.toml default.
const CONFIG_DEFAULT: { [K in keyof Settings]?: (config: AppConfig) => unknown } = {
  diffStyle: (config) => config.diffStyle,
  diffTheme: (config) => config.diffTheme,
  lineBackgrounds: (config) => config.lineBackgrounds,
  lineNumbers: (config) => config.lineNumbers,
  wordWrap: (config) => config.wordWrap,
};

// Values are persisted with String(), so compare string forms.
function parse<K extends keyof Settings>(name: K, raw: unknown): Settings[K] | undefined {
  return (SPEC[name].values as Settings[K][]).find((value) => String(value) === String(raw));
}

// Resolves each setting as: saved in localStorage, else server config, else default.
export function useSettings(config: AppConfig) {
  const [stored, setStored] = useState(
    () =>
      Object.fromEntries(
        NAMES.map((name) => [name, parse(name, localStorage.getItem(SPEC[name].key))]),
      ) as Partial<Settings>,
  );
  const settings = useMemo(
    () =>
      Object.fromEntries(
        NAMES.map((name) => [
          name,
          stored[name] ?? parse(name, CONFIG_DEFAULT[name]?.(config)) ?? SPEC[name].values[0],
        ]),
      ) as Settings,
    [stored, config],
  );
  const setSetting = useCallback<SetSetting>((name, value) => {
    localStorage.setItem(SPEC[name].key, String(value));
    setStored((current) => ({ ...current, [name]: value }));
  }, []);
  return [settings, setSetting] as const;
}
