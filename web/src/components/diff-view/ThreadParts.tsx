import { IconTrash } from "@tabler/icons-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReviewThread } from "./types";

function escapeSvgText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function avatarDataUri(author: string): string {
  const label = escapeSvgText(author.trim().slice(0, 1).toUpperCase() || "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="10" fill="#e5e5e5"/><text x="10" y="13" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="10" font-weight="600" fill="#525252">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function CommentAvatar({ author }: { author?: string }) {
  const name = author?.trim() || "Commenter";

  return (
    <img
      alt={name}
      className="size-5 shrink-0 rounded-full object-cover"
      src={avatarDataUri(name)}
    />
  );
}

const badgeClass = "rounded-full px-1.5 py-0.5 text-[10px]";
const neutralBadge = `${badgeClass} bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300`;

export function ThreadBadges({ thread }: { thread: ReviewThread }) {
  return (
    <>
      {thread.status === "resolved" && <span className={neutralBadge}>Resolved</span>}
      {thread.pending && (
        <span
          className={`${badgeClass} bg-amber-100 font-medium text-amber-700 dark:bg-amber-400/15 dark:text-amber-300`}
        >
          Pending
        </span>
      )}
      {thread.comments.length > 1 && <span className={neutralBadge}>{thread.comments.length}</span>}
    </>
  );
}

// `className` supplies placement and the parent's group-hover reveal.
export function DeleteThreadButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={`text-muted-foreground hover:bg-destructive/10 hover:text-destructive inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
            aria-label="Delete comment"
            onClick={onClick}
          >
            <IconTrash size={14} />
          </button>
        }
      />
      <TooltipContent>Delete comment</TooltipContent>
    </Tooltip>
  );
}
