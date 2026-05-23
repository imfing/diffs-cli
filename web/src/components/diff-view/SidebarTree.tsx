import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { GitStatusEntry } from '@pierre/trees';
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import { IconSearch as Search } from '@tabler/icons-react';
import { FolderTree, MessageCircle, MessageCircleMore } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommentAvatar } from './CommentAvatar';
import type { ReviewThread } from './types';
import { latestThreadComment, threadEndLine, threadLineLabel } from './helpers';

type SidebarSection = 'files' | 'comments';

const fileTreeSearchCss = `
  [data-file-tree-search-container][data-open='false'] {
    display: none;
  }
`;

function gitStatusForFile(file: FileDiffMetadata): GitStatusEntry['status'] {
  switch (file.type) {
    case 'new':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'rename-pure':
    case 'rename-changed':
      return 'renamed';
    case 'change':
    default:
      return 'modified';
  }
}

export function SidebarTree({
  paths,
  files,
  comments,
  onFileActivate,
  onCommentActivate,
}: {
  paths: readonly string[];
  files: readonly FileDiffMetadata[];
  comments: readonly ReviewThread[];
  onFileActivate: (path: string) => void;
  onCommentActivate: (thread: ReviewThread) => void;
}) {
  const [section, setSection] = useState<SidebarSection>('files');
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const filePathSetRef = useRef(filePathSet);
  const onFileActivateRef = useRef(onFileActivate);
  const openComments = useMemo(() => comments.filter((thread) => thread.status === 'open'), [comments]);
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
  const pathsKey = useMemo(() => paths.join('\0'), [paths]);
  const gitStatusKey = useMemo(
    () => gitStatus.map((entry) => `${entry.path}\0${entry.status}`).join('\0'),
    [gitStatus],
  );
  const pathsKeyRef = useRef(pathsKey);
  const gitStatusKeyRef = useRef(gitStatusKey);

  const { model } = useFileTree({
    paths,
    gitStatus,
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    initialExpansion: 'open',
    icons: 'standard',
    density: 'compact',
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
    if (pathsKeyRef.current === pathsKey) return;
    pathsKeyRef.current = pathsKey;
    model.resetPaths(paths);
  }, [model, paths, pathsKey]);

  useEffect(() => {
    if (gitStatusKeyRef.current === gitStatusKey) return;
    gitStatusKeyRef.current = gitStatusKey;
    model.setGitStatus(gitStatus);
  }, [gitStatus, gitStatusKey, model]);

  const search = useFileTreeSearch(model);
  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!(target instanceof HTMLElement)) continue;
        if (target.dataset.itemType !== 'file') continue;
        const path = target.dataset.itemPath;
        if (path != null && filePathSet.has(path)) {
          onFileActivate(path);
        }
        return;
      }
    },
    [filePathSet, onFileActivate],
  );

  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    let lines = 0;
    for (const f of files) {
      lines += f.unifiedLineCount;
      for (const h of f.hunks) {
        additions += h.additionLines;
        deletions += h.deletionLines;
      }
    }
    return { files: paths.length, additions, deletions, lines };
  }, [files, paths.length]);
  const CommentsIcon = openComments.length > 0 ? MessageCircleMore : MessageCircle;

  return (
    <div className="flex h-full flex-col pt-3">
      <div className="flex items-center gap-3 px-3 pb-1">
        <div className="mr-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={section === 'files' ? 'text-foreground' : 'text-muted-foreground'}
            title="Files"
            aria-pressed={section === 'files'}
            onClick={() => setSection('files')}
          >
            <FolderTree size={14} />
            <span className="sr-only">Files</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={section === 'comments' ? 'gap-1 text-foreground' : 'gap-1 text-muted-foreground'}
            title="Comments"
            aria-pressed={section === 'comments'}
            onClick={() => setSection('comments')}
          >
            <CommentsIcon size={14} />
            <span className="sr-only">Comments</span>
            {openComments.length > 0 && (
              <span
                aria-hidden="true"
                className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-neutral-200 px-1 text-[10px] leading-none font-medium tabular-nums text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
              >
                {openComments.length}
              </span>
            )}
          </Button>
        </div>
        {section === 'files' && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="Search files"
            aria-pressed={search.isOpen}
            onPointerDown={(event) => {
              if (search.isOpen) {
                event.preventDefault();
              }
            }}
            onClick={() => (search.isOpen ? search.close() : search.open(''))}
          >
            <Search size={14} />
          </Button>
        )}
      </div>

      <div className="mt-2 min-h-0 flex-1">
        {section === 'files' ? (
          <FileTree model={model} onClick={handleTreeClick} style={{ height: '100%' }} />
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
                      className="text-muted-foreground hover:text-foreground block w-full cursor-pointer p-3 pb-2 text-left text-sm font-medium break-all outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onFileActivate(path)}
                    >
                      <span className="select-text">{path}</span>
                    </button>
                    <div className="overflow-hidden rounded-lg border border-[rgb(0_0_0_/_0.1)] bg-white dark:border-[rgb(255_255_255_/_0.15)] dark:bg-neutral-800">
                      {threads.map((thread) => {
                        const latestComment = latestThreadComment(thread);
                        return (
                          <button
                            key={thread.id}
                            type="button"
                            className="hover:bg-muted flex w-full cursor-pointer items-start gap-2 border-b border-[rgb(0_0_0_/_0.1)] bg-card p-3 text-left text-sm transition-colors outline-none first:rounded-t-lg last:rounded-b-lg last:border-b-0 focus-visible:ring-2 focus-visible:ring-ring dark:border-[rgb(255_255_255_/_0.15)] dark:bg-neutral-800 dark:hover:bg-[var(--diffshub-sidebar-bg)]"
                            onClick={() => onCommentActivate(thread)}
                          >
                            <CommentAvatar author={latestComment?.author} />
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5 select-text">
                              <div className="flex min-w-0 items-center gap-2">
                                <span>
                                  <span className="text-muted-foreground">
                                    {latestComment?.author ? `${latestComment.author} commented on ` : 'Commented on '}
                                  </span>
                                  <span className="font-medium text-emerald-700 dark:text-emerald-400">
                                    {threadLineLabel(thread)}
                                  </span>
                                </span>
                                {thread.status === 'resolved' && (
                                  <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                                    Resolved
                                  </span>
                                )}
                                {thread.comments.length > 1 && (
                                  <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                                    {thread.comments.length}
                                  </span>
                                )}
                              </div>
                              <p className="text-foreground line-clamp-3 w-full break-words whitespace-pre-wrap">
                                {latestComment?.body ?? ''}
                              </p>
                            </div>
                          </button>
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

      <div className="shrink-0 border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
        <div className="flex items-center justify-between py-0.5 text-xs">
          <span className="text-neutral-500">Files</span>
          <span className="font-mono tabular-nums font-semibold">{stats.files.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between border-t border-neutral-200/75 py-0.5 text-xs dark:border-neutral-700/75">
          <span className="text-neutral-500">Additions</span>
          <span className="font-mono tabular-nums font-semibold text-green-600 dark:text-green-400">
            +{stats.additions.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-neutral-200/75 py-0.5 text-xs dark:border-neutral-700/75">
          <span className="text-neutral-500">Deletions</span>
          <span className="font-mono tabular-nums font-semibold text-red-600 dark:text-red-400">
            -{stats.deletions.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-neutral-200/75 py-0.5 text-xs dark:border-neutral-700/75">
          <span className="text-neutral-500">Lines</span>
          <span className="font-mono tabular-nums font-semibold">{stats.lines.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
