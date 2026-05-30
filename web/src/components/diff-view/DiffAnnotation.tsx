import { CommentInput } from "@/components/CommentInput";
import { IconTrash } from "@tabler/icons-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CommentAvatar } from "./CommentAvatar";
import type { AnnotationMeta, ReviewThread } from "./types";

type AnnotationLike = {
  metadata?: AnnotationMeta;
};

export function DiffAnnotation({
  annotation,
  onCancelComment,
  onDeleteComment,
  onSubmitComment,
}: {
  annotation: AnnotationLike;
  onCancelComment: () => void;
  onDeleteComment: (thread: ReviewThread) => void;
  onSubmitComment: (body: string) => void;
}) {
  const meta = annotation.metadata;
  if (!meta) return null;

  if (meta.type === "input") {
    return <CommentInput onSubmit={onSubmitComment} onCancel={onCancelComment} />;
  }

  if (meta.type !== "comment") return null;

  const latestComment = meta.thread.comments[meta.thread.comments.length - 1];
  const canDelete = meta.thread.pending || meta.thread.provider === "local";
  return (
    <div className="group/comment relative m-2 ml-3 flex max-w-[600px] items-start gap-2 rounded-lg border border-[rgb(0_0_0_/_0.1)] bg-card bg-clip-padding p-3 font-sans text-sm shadow-[0_2px_4px_rgb(0_0_0_/_0.025),0_4px_8px_rgb(0_0_0_/_0.025)] dark:border-[rgb(255_255_255_/_0.15)] dark:bg-neutral-800 dark:shadow-[0_2px_4px_rgb(0_0_0_/_0.25),0_4px_8px_rgb(0_0_0_/_0.25)]">
      <CommentAvatar author={latestComment?.author} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-muted-foreground flex min-w-0 items-center gap-2">
          <span>{latestComment?.author ? `${latestComment.author} commented` : "Commented"}</span>
          {meta.thread.comments.length > 1 && (
            <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
              {meta.thread.comments.length}
            </span>
          )}
          {meta.thread.pending && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
              Pending
            </span>
          )}
        </div>
        <p className="text-foreground w-full break-words whitespace-pre-wrap">
          {latestComment?.body ?? ""}
        </p>
      </div>
      {canDelete && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive -mr-1 -mt-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition group-hover/comment:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Delete comment"
                onClick={() => onDeleteComment(meta.thread)}
              >
                <IconTrash size={14} />
              </button>
            }
          />
          <TooltipContent>Delete comment</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
