import type { ReactNode } from 'react';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '../ui/drawer';

export default function MobileSidebarDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="border-neutral-200 bg-neutral-50 p-0 dark:border-neutral-700 dark:bg-neutral-900 md:hidden">
        <DrawerHeader className="sr-only">
          <DrawerTitle>Sidebar</DrawerTitle>
          <DrawerDescription>Browse files, comments, and diff stats.</DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}
