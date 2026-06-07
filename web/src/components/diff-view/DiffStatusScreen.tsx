import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

// Full-screen centered status (failed-to-load, no files, all-reviewed). The
// icon/title/description/action shape is identical across them, so it lives here
// instead of being copy-pasted per branch in DiffView.
export function DiffStatusScreen({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {children != null && <EmptyContent>{children}</EmptyContent>}
      </Empty>
    </div>
  );
}
