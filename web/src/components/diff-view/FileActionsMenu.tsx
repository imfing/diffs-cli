import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconDots } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fileBaseName } from "./helpers";

const COPIED_RESET_MS = 1500;

interface CopyAction {
  key: string;
  label: string;
  getText: () => string | null;
}

export function FileActionsMenu({
  path,
  diffText,
}: {
  path: string;
  diffText: string | undefined;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const resetTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = useCallback(async (action: CopyAction) => {
    const text = action.getText();
    if (text == null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(action.key);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopiedKey(null), COPIED_RESET_MS);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  }, []);

  const actions: CopyAction[] = [
    { key: "diff", label: "Copy diff", getText: () => diffText ?? null },
    { key: "path", label: "Copy full path", getText: () => path },
    { key: "name", label: "Copy filename", getText: () => fileBaseName(path) },
  ];

  // Stop propagation so opening the menu doesn't also collapse the file header.
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <DropdownMenu onOpenChange={(open) => !open && setCopiedKey(null)}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 p-0 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 [&_svg]:size-4"
              aria-label="File actions"
            >
              <IconDots />
            </Button>
          }
        />
        <DropdownMenuContent className="[&_[data-slot=dropdown-menu-item]]:text-[12px]">
          {actions.map((action) => {
            const copied = copiedKey === action.key;
            return (
              <DropdownMenuItem
                key={action.key}
                closeOnClick={false}
                disabled={action.getText() == null}
                onClick={() => copy(action)}
              >
                {copied ? <IconCheck className="text-green-600! dark:text-green-400!" /> : null}
                {copied ? "Copied" : action.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
