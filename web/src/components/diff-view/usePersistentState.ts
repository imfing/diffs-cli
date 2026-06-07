import { useCallback, useState } from "react";

// State backed by localStorage. `decode` validates the stored string (returning
// null for missing/invalid values so `fallback` applies); the setter writes back
// via `String(value)`, matching how these scalar prefs were always persisted.
export function usePersistentState<T extends string | boolean>(
  key: string,
  fallback: T,
  decode: (raw: string | null) => T | null,
) {
  const [value, setValue] = useState<T>(() => decode(localStorage.getItem(key)) ?? fallback);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      localStorage.setItem(key, String(next));
    },
    [key],
  );
  // `setValue` (third element) updates state without persisting — used to apply
  // server-config defaults so they don't masquerade as an explicit user choice.
  return [value, set, setValue] as const;
}

// Decoder for the "true"/"false" booleans persisted by these settings.
export function decodeStoredBool(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}
