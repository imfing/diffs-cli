import { Dialog } from "@base-ui/react/dialog";
import { IconX } from "@tabler/icons-react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";

type Shortcut = { keys: string[]; label: string };

const NAV_SHORTCUTS: Shortcut[] = [
  { keys: ["n"], label: "Next file" },
  { keys: ["p"], label: "Previous file" },
  { keys: ["m"], label: "Mark file as reviewed" },
  { keys: ["?"], label: "Toggle this help" },
];

function ShortcutRow({ keys, label }: Shortcut) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <KbdGroup>
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
    </div>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-popover p-4 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-sm font-medium">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <IconX size={15} />
            </Dialog.Close>
          </div>
          <div className="flex flex-col text-xs">
            {NAV_SHORTCUTS.map((shortcut) => (
              <ShortcutRow key={shortcut.label} {...shortcut} />
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
