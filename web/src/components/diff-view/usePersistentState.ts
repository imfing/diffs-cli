import { useCallback, useState } from "react";

// Setter writes via String(value), matching the existing persisted format.
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
  // setValue (3rd element) updates state without persisting.
  return [value, set, setValue] as const;
}

export function decodeStoredBool(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}
