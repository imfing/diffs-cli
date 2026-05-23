import { X } from "lucide-react";
import { CommentInput } from "@/components/CommentInput";
import { CommentAvatar } from "./CommentAvatar";
import type { AnnotationMeta } from "./types";

type AnnotationLike = {
  metadata?: AnnotationMeta;
};

export function DiffAnnotation({
  annotation,
  onCancelComment,
  onResolveThread,
  onSubmitComment,
}: {
  annotation: AnnotationLike;
  onCancelComment: () => void;
  onResolveThread: (threadId: string) => void;
  onSubmitComment: (body: string) => void;
}) {
  const meta = annotation.metadata;
  if (!meta) return null;

  if (meta.type === "input") {
    return <CommentInput onSubmit={onSubmitComment} onCancel={onCancelComment} />;
  }

  if (meta.type !== "comment") return null;

  const latestComment = meta.thread.comments[meta.thread.comments.length - 1];
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
        </div>
        <p className="text-foreground w-full break-words whitespace-pre-wrap">
          {latestComment?.body ?? ""}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onResolveThread(meta.thread.id)}
        className="absolute -right-2 -top-2 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-400 opacity-0 shadow-sm transition-all hover:border-red-200 hover:bg-red-50 hover:text-red-500 group-hover/comment:opacity-100 dark:border-neutral-600 dark:bg-neutral-800 dark:hover:border-red-700 dark:hover:bg-red-900/40"
        title="Resolve comment"
      >
        <X size={12} />
      </button>
    </div>
  );
}
