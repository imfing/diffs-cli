import {
  type ComponentProps,
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import {
  IconListTree,
  IconMessageCircle,
  IconMessageCirclePlus,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ResolvedColorScheme } from "@/lib/colorScheme";
import { DIFF_SURFACE_FONT_SIZE } from "@/lib/diffTypography";
import { CommentAvatar, DeleteThreadButton, ThreadBadges } from "./ThreadParts";
import type { ReviewThread } from "./types";
import { latestThreadComment, threadEndLine, threadLineLabel } from "./helpers";
import { DiffStats } from "./DiffStats";

type SidebarSection = "files" | "comments";
type FileTreeStyle = CSSProperties & Record<`--${string}`, string | number>;

const fileTreeSearchCss = `
  [data-file-tree-search-container][data-open='false'] {
    display: none;
  }
`;

function gitStatusForFile(file: FileDiffMetadata): GitStatusEntry["status"] {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
    default:
      return "modified";
  }
}

// "a/b/c.ts" -> ["a/", "a/b/"], matching the tree's folder row paths.
function ancestorDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join("/")}/`);
}

function SidebarIconButton({
  tooltip,
  ...buttonProps
}: { tooltip: string } & ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" {...buttonProps} />} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function SidebarTree({
  paths,
  files,
  reviewedPaths,
  comments,
  onFileActivate,
  onCommentActivate,
  onDeleteComment,
  onClose,
  colorScheme,
}: {
  paths: readonly string[];
  files: readonly FileDiffMetadata[];
  reviewedPaths: ReadonlySet<string>;
  comments: readonly ReviewThread[];
  onFileActivate: (path: string) => void;
  onCommentActivate: (thread: ReviewThread) => void;
  onDeleteComment: (thread: ReviewThread) => void;
  onClose?: () => void;
  colorScheme: ResolvedColorScheme;
}) {
  const [section, setSection] = useState<SidebarSection>("files");
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const filePathSetRef = useRef(filePathSet);
  const onFileActivateRef = useRef(onFileActivate);
  const openComments = useMemo(
    () => comments.filter((thread) => thread.status === "open"),
    [comments],
  );
  const commentsByPath = useMemo(() => {
    const map = new Map<string, ReviewThread[]>();
    for (const thread of comments) {
      const bucket = map.get(thread.path);
      if (bucket) {
        bucket.push(thread);
      } else {
        map.set(thread.path, [thread]);
      }
    }
    return [...map.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([path, threads]) => ({
        path,
        threads: threads.toSorted((a, b) => a.line - b.line || threadEndLine(a) - threadEndLine(b)),
      }));
  }, [comments]);

  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      files.map((file) => ({
        path: file.name,
        status: gitStatusForFile(file),
      })),
    [files],
  );

  const { model } = useFileTree({
    paths,
    gitStatus,
    search: true,
    fileTreeSearchMode: "hide-non-matches",
    initialExpansion: "open",
    icons: "standard",
    density: "compact",
    flattenEmptyDirectories: true,
    unsafeCSS: fileTreeSearchCss,
    onSelectionChange: (selected) => {
      const selectedFilePath = selected.find((path) => filePathSetRef.current.has(path));
      if (selectedFilePath != null) {
        onFileActivateRef.current(selectedFilePath);
      }
    },
  });

  useEffect(() => {
    filePathSetRef.current = filePathSet;
    onFileActivateRef.current = onFileActivate;
  }, [filePathSet, onFileActivate]);

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);
  // The tree has no per-row styling API (and unsafeCSS is fixed at creation), so dim
  // reviewed rows via a style element in its open shadow root. The shadow root is attached
  // after this effect on (re)mount, hence the frame delay. Folders (rows keyed "dir/") dim
  // once every file under them is reviewed.
  useEffect(() => {
    const unreviewedDirs = new Set(
      paths.filter((path) => !reviewedPaths.has(path)).flatMap(ancestorDirs),
    );
    const dimmed = [...reviewedPaths].flatMap((path) => [
      path,
      ...ancestorDirs(path).filter((dir) => !unreviewedDirs.has(dir)),
    ]);
    const style = document.createElement("style");
    style.textContent = [...new Set(dimmed)]
      .map((path) => `[data-item-path="${CSS.escape(path)}"] { opacity: 0.5; }`)
      .join("\n");
    const frame = requestAnimationFrame(() =>
      model.getFileTreeContainer()?.shadowRoot?.append(style),
    );
    return () => {
      cancelAnimationFrame(frame);
      style.remove();
    };
  }, [model, paths, reviewedPaths, section]);

  const search = useFileTreeSearch(model);
  const fileTreeStyle = useMemo<FileTreeStyle>(
    () => ({
      height: "100%",
      colorScheme,
      backgroundColor: "var(--sidebar)",
      color: "var(--sidebar-foreground)",
      borderColor: "var(--sidebar-border)",
      "--trees-bg-override": "var(--sidebar)",
      "--trees-fg-override": "var(--sidebar-foreground)",
      "--trees-fg-muted-override": "var(--muted-foreground)",
      "--trees-bg-muted-override": "var(--muted)",
      "--trees-border-color-override": "var(--sidebar-border)",
      "--trees-search-bg-override": "var(--card)",
      "--trees-selected-bg-override": "var(--accent)",
      "--trees-selected-fg-override": "var(--accent-foreground)",
      "--trees-font-size-override": DIFF_SURFACE_FONT_SIZE,
    }),
    [colorScheme],
  );

  const CommentsIcon = openComments.length > 0 ? IconMessageCirclePlus : IconMessageCircle;

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center gap-3 px-4 pt-5 pb-2 md:px-3 md:pt-3 md:pb-1">
        <div
          className="mr-auto flex items-center gap-0.5"
          role="group"
          aria-label="Sidebar sections"
        >
          <SidebarIconButton
            tooltip="Files"
            variant="ghost"
            size="icon-sm"
            className={`size-7 ${section === "files" ? "text-foreground" : "text-muted-foreground"}`}
            aria-label="Files"
            aria-pressed={section === "files"}
            onClick={() => setSection("files")}
          >
            <IconListTree size={16} />
            <span className="sr-only">Files</span>
          </SidebarIconButton>
          <SidebarIconButton
            tooltip="Comments"
            variant="ghost"
            size={openComments.length > 0 ? "sm" : "icon-sm"}
            className={`${openComments.length > 0 ? "h-7 px-1.5" : "size-7"} ${section === "comments" ? "text-foreground" : "text-muted-foreground"}`}
            aria-label="Comments"
            aria-pressed={section === "comments"}
            onClick={() => setSection("comments")}
          >
            <CommentsIcon size={16} />
            <span className="sr-only">Comments</span>
            {openComments.length > 0 && (
              <span
                aria-hidden="true"
                className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-neutral-200 px-1 text-[10px] leading-none font-medium tabular-nums text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
              >
                {openComments.length}
              </span>
            )}
          </SidebarIconButton>
        </div>
        {section === "files" && (
          <SidebarIconButton
            tooltip="Show file search"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground"
            aria-label="Show file search"
            aria-pressed={search.isOpen}
            onPointerDown={(event) => {
              if (search.isOpen) {
                event.preventDefault();
              }
            }}
            onClick={() => (search.isOpen ? search.close() : search.open(""))}
          >
            <IconSearch size={16} />
          </SidebarIconButton>
        )}
        {onClose && (
          <SidebarIconButton
            tooltip="Close file tree"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground md:hidden"
            aria-label="Close file tree"
            onClick={onClose}
          >
            <IconX size={16} />
          </SidebarIconButton>
        )}
      </div>

      <div className="mt-2 min-h-0 flex-1">
        {section === "files" ? (
          <FileTree model={model} style={fileTreeStyle} />
        ) : (
          <div className="h-full overflow-auto px-3 pb-3">
            {commentsByPath.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                No comments yet.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {commentsByPath.map(({ path, threads }) => (
                  <section key={path}>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground block w-full cursor-pointer p-3 pb-2 text-left text-xs font-medium break-all outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onFileActivate(path)}
                    >
                      <span className="select-text">{path}</span>
                    </button>
                    <div className="overflow-hidden rounded-lg border border-[rgb(0_0_0_/_0.1)] bg-white dark:border-[rgb(255_255_255_/_0.15)] dark:bg-neutral-800">
                      {threads.map((thread) => {
                        const latestComment = latestThreadComment(thread);
                        const canDelete = thread.pending || thread.provider === "local";
                        return (
                          <div
                            key={thread.id}
                            className="group/thread flex border-b border-[rgb(0_0_0_/_0.1)] bg-card transition-colors last:border-b-0 hover:bg-muted dark:border-[rgb(255_255_255_/_0.15)] dark:bg-neutral-800 dark:hover:bg-[var(--diffshub-sidebar-bg)]"
                          >
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 p-3 pr-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => onCommentActivate(thread)}
                            >
                              <CommentAvatar author={latestComment?.author} />
                              <div className="flex min-w-0 flex-1 flex-col gap-0.5 select-text">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span>
                                    <span className="text-muted-foreground">
                                      {latestComment?.author
                                        ? `${latestComment.author} commented on `
                                        : "Commented on "}
                                    </span>
                                    <span className="font-medium text-emerald-700 dark:text-emerald-400">
                                      {threadLineLabel(thread)}
                                    </span>
                                  </span>
                                  <ThreadBadges thread={thread} />
                                </div>
                                <p className="text-foreground line-clamp-3 w-full break-words whitespace-pre-wrap">
                                  {latestComment?.body ?? ""}
                                </p>
                              </div>
                            </button>
                            {canDelete && (
                              <DeleteThreadButton
                                className="my-2 mr-2 group-hover/thread:opacity-100"
                                onClick={() => onDeleteComment(thread)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <DiffStats files={files} pathCount={paths.length} />
    </div>
  );
}
