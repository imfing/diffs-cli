import { useCallback, useEffect, useMemo, useState, useRef, lazy, Suspense } from "react";
import { useParams, Link } from "react-router";
import {
  parsePatchFiles,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, useWorkerPool } from "@pierre/diffs/react";
import {
  applyColorScheme,
  initialColorScheme,
  isAppColorScheme,
  persistColorScheme,
  storedColorScheme,
  type AppColorScheme,
} from "@/lib/colorScheme";
import { ChevronRight } from "lucide-react";
import { DiffAnnotation } from "./diff-view/DiffAnnotation";
import { DiffToolbar } from "./diff-view/DiffToolbar";
import { SidebarTree } from "./diff-view/SidebarTree";
import type {
  AnnotationMeta,
  AppConfig,
  CodeViewLineSelection,
  CommentTarget,
  DiffStyle,
  DiffThemeId,
  PendingCommentDraft,
  PatchLoadState,
  PullRequestInfo,
  ReviewThread,
} from "./diff-view/types";
import {
  diffThemeOptions,
  isDiffStyle,
  isDiffThemeId,
  localRepoTitle,
  selectedRangeEndLine,
  selectedRangeEndSide,
  selectedRangeSide,
  threadEndLine,
  threadEndSide,
} from "./diff-view/helpers";
import { apiFetch } from "@/lib/api";

const MobileSidebarDrawer = lazy(() => import("./diff-view/MobileSidebarDrawer"));

const codeViewStyle = { flex: 1, overflow: "auto" as const };

const STORAGE_DIFF_THEME = "diff-theme";
const STORAGE_DIFF_STYLE = "diffs-diff-style";
const STORAGE_WORD_WRAP = "diffs-word-wrap";
const STORAGE_LINE_NUMBERS = "diffs-line-numbers";
const STORAGE_LINE_BACKGROUNDS = "diffs-line-backgrounds";

function readStoredBool(key: string): boolean | null {
  const value = localStorage.getItem(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function readStoredDiffStyle(): DiffStyle | null {
  const value = localStorage.getItem(STORAGE_DIFF_STYLE);
  return isDiffStyle(value) ? value : null;
}

function readStoredDiffTheme(): DiffThemeId | null {
  const value = localStorage.getItem(STORAGE_DIFF_THEME);
  return isDiffThemeId(value) ? value : null;
}

function patchCacheKeyPrefix(patch: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < patch.length; i++) {
    h ^= patch.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function createPendingThread(target: CommentTarget, body: string): ReviewThread {
  const now = new Date().toISOString();
  const draft: PendingCommentDraft = {
    path: target.path,
    side: target.side,
    line: target.line,
    endSide: target.endSide,
    endLine: target.endLine,
    body,
  };
  const hasRange = target.endLine !== target.line || target.endSide !== target.side;
  return {
    id: `pending:${crypto.randomUUID()}`,
    provider: "pending",
    branch: "",
    path: target.path,
    side: target.side,
    line: target.line,
    endSide: hasRange ? target.endSide : undefined,
    endLine: hasRange ? target.endLine : undefined,
    status: "open",
    comments: [
      {
        id: `pending-comment:${crypto.randomUUID()}`,
        author: "You",
        body,
        createdAt: now,
      },
    ],
    pending: true,
    draft,
  };
}

export function DiffView({ source = "pr" }: { source?: "pr" | "local" } = {}) {
  const { org, repo, number } = useParams<{
    org: string;
    repo: string;
    number: string;
  }>();

  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() => readStoredDiffStyle() ?? "split");
  const [diffThemeId, setDiffThemeId] = useState<DiffThemeId>(() => readStoredDiffTheme() ?? "pierre");
  const [appColorScheme, setAppColorScheme] = useState<AppColorScheme>(() => initialColorScheme());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showBackground, setShowBackground] = useState(() => readStoredBool(STORAGE_LINE_BACKGROUNDS) ?? true);
  const [showLineNumbers, setShowLineNumbers] = useState(() => readStoredBool(STORAGE_LINE_NUMBERS) ?? true);
  const [wordWrap, setWordWrap] = useState(() => readStoredBool(STORAGE_WORD_WRAP) ?? false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [submittingPendingComments, setSubmittingPendingComments] = useState(false);
  const viewerRef = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  const [commentThreads, setCommentThreads] = useState<ReviewThread[]>([]);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [pullRequestInfo, setPullRequestInfo] = useState<{
    endpoint: string;
    info: PullRequestInfo;
  } | null>(null);
  const [config, setConfig] = useState<AppConfig>({
    cwd: "",
    gitBranch: "",
    githubHost: "github.com",
  });

  const isLocal = source === "local";
  const prUrl = `https://${config.githubHost}/${org}/${repo}/pull/${number}`;
  const commentsEndpoint = isLocal
    ? "/api/comments"
    : org && repo && number
      ? `/api/comments?org=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}&number=${encodeURIComponent(number)}`
      : null;
  const pullRequestInfoEndpoint =
    !isLocal && org && repo && number
      ? `/api/pull/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`
      : null;
  const pageTitle = isLocal
    ? `${localRepoTitle(config.cwd, config.gitBranch)} - diffs`
    : org && repo && number
      ? `${org}/${repo}/pull/${number} - diffs`
      : "diffs";
  const [patchState, setPatchState] = useState<PatchLoadState>({
    error: null,
    patch: null,
    status: "loading",
  });

  useEffect(() => {
    apiFetch<AppConfig>("/api/config")
      .then((nextConfig) => {
        setConfig(nextConfig);
        if (isAppColorScheme(nextConfig.colorScheme) && storedColorScheme() == null) {
          setAppColorScheme(nextConfig.colorScheme);
        }
        if (isDiffThemeId(nextConfig.diffTheme) && readStoredDiffTheme() == null) {
          setDiffThemeId(nextConfig.diffTheme);
        }
        if (isDiffStyle(nextConfig.diffStyle) && readStoredDiffStyle() == null) {
          setDiffStyle(nextConfig.diffStyle);
        }
        if (typeof nextConfig.wordWrap === "boolean" && readStoredBool(STORAGE_WORD_WRAP) == null) {
          setWordWrap(nextConfig.wordWrap);
        }
        if (typeof nextConfig.lineNumbers === "boolean" && readStoredBool(STORAGE_LINE_NUMBERS) == null) {
          setShowLineNumbers(nextConfig.lineNumbers);
        }
        if (typeof nextConfig.lineBackgrounds === "boolean" && readStoredBool(STORAGE_LINE_BACKGROUNDS) == null) {
          setShowBackground(nextConfig.lineBackgrounds);
        }
      })
      .catch(() => {
        setConfig((current) => current);
      });
  }, []);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    applyColorScheme(appColorScheme);
  }, [appColorScheme]);

  const loadComments = useCallback(() => {
    if (commentsEndpoint == null) return;
    apiFetch<{ threads?: ReviewThread[] }>(commentsEndpoint)
      .then((data) => {
        setCommentThreads(data.threads ?? []);
      })
      .catch(() => {
        setCommentThreads([]);
      });
  }, [commentsEndpoint]);

  useEffect(() => {
    let ignore = false;
    let eventSource: EventSource | undefined;
    let fallbackInterval: number | undefined;

    const load = () => {
      const endpoint = isLocal ? "/api/local-diff" : `/api/patch/${org}/${repo}/${number}`;
      apiFetch<string>(endpoint)
        .then((text) => {
          if (!ignore) {
            setPatchState({
              error: null,
              patch: text,
              status: "loaded",
            });
          }
        })
        .catch((err: unknown) => {
          if (!ignore) {
            setPatchState({
              error: err instanceof Error ? err.message : String(err),
              patch: null,
              status: "error",
            });
          }
        });
    };

    if (!isLocal && (!org || !repo || !number)) return;
    load();
    if (isLocal) {
      eventSource = new EventSource("/api/events");
      eventSource.addEventListener("diff", load);
      fallbackInterval = window.setInterval(load, 30000);
    }

    return () => {
      ignore = true;
      eventSource?.close();
      if (fallbackInterval != null) window.clearInterval(fallbackInterval);
    };
  }, [isLocal, org, repo, number]);

  useEffect(() => {
    if (pullRequestInfoEndpoint == null) return;
    let ignore = false;
    apiFetch<PullRequestInfo>(pullRequestInfoEndpoint)
      .then((info) => {
        if (!ignore) setPullRequestInfo({ endpoint: pullRequestInfoEndpoint, info });
      })
      .catch(() => {
        if (!ignore) setPullRequestInfo((current) => (current?.endpoint === pullRequestInfoEndpoint ? null : current));
      });
    return () => {
      ignore = true;
    };
  }, [pullRequestInfoEndpoint]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const loading = patchState.status === "loading";
  const error = patchState.status === "error" ? patchState.error : null;

  const files = useMemo<FileDiffMetadata[]>(() => {
    if (patchState.status !== "loaded" || !patchState.patch) return [];
    const parsed = parsePatchFiles(patchState.patch, patchCacheKeyPrefix(patchState.patch));
    return parsed.flatMap((p) => p.files);
  }, [patchState]);
  const codeViewKey = patchState.patch ?? "empty";
  const pendingCommentThreads = useMemo(
    () => commentThreads.filter((thread) => thread.pending && thread.draft),
    [commentThreads],
  );
  const currentPullRequestInfo =
    pullRequestInfo?.endpoint === pullRequestInfoEndpoint ? pullRequestInfo.info : null;

  const filePaths = useMemo(() => [...new Set(files.map((f) => f.name))], [files]);
  const initialItems = useMemo<CodeViewItem<AnnotationMeta>[]>(
    () => files.map((f, i) => ({ id: `diff:${f.name}:${i}`, type: "diff" as const, fileDiff: f })),
    [files],
  );
  const filePathToItemId = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < files.length; i++) {
      if (!map.has(files[i].name)) map.set(files[i].name, `diff:${files[i].name}:${i}`);
    }
    return map;
  }, [files]);
  const selectedDiffTheme = useMemo(
    () => diffThemeOptions.find((option) => option.id === diffThemeId) ?? diffThemeOptions[0],
    [diffThemeId],
  );
  const workerPool = useWorkerPool();
  useEffect(() => {
    void workerPool?.setRenderOptions({ theme: selectedDiffTheme.theme });
  }, [workerPool, selectedDiffTheme.theme]);
  const scrollToFile = useCallback(
    (path: string) => {
      const itemId = filePathToItemId.get(path);
      if (itemId == null) return;
      viewerRef.current?.scrollTo({
        type: "item",
        id: itemId,
        align: "start",
        behavior: "smooth-auto",
      });
      setMobileSidebarOpen(false);
    },
    [filePathToItemId],
  );
  const scrollToThread = useCallback(
    (thread: ReviewThread) => {
      const itemId = filePathToItemId.get(thread.path);
      if (itemId == null) return;
      const range: SelectedLineRange = {
        start: thread.line,
        side: thread.side,
        end: threadEndLine(thread),
        endSide: threadEndSide(thread),
      };
      setSelectedLines({ id: itemId, range });
      viewerRef.current?.scrollTo({
        type: "range",
        id: itemId,
        range,
        align: "center",
        behavior: "smooth-auto",
      });
      setMobileSidebarOpen(false);
    },
    [filePathToItemId],
  );
  const openSidebar = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileSidebarOpen(true);
      return;
    }
    setSidebarOpen((open) => !open);
  }, []);
  const toggleFileCollapsed = useCallback((itemId: string) => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (item == null) return;
    viewer!.updateItem({
      ...item,
      version: (item.version ?? 0) + 1,
      collapsed: !item.collapsed,
    });
  }, []);
  const toggleAllFilesCollapsed = useCallback(() => {
    const next = !allCollapsed;
    setAllCollapsed(next);
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const item of initialItems) {
      const current = viewer.getItem(item.id);
      if (current && current.collapsed !== next) {
        viewer.updateItem({ ...current, version: (current.version ?? 0) + 1, collapsed: next });
      }
    }
  }, [allCollapsed, initialItems]);
  const handleColorSchemeChange = useCallback((value: AppColorScheme) => {
    setAppColorScheme(value);
    persistColorScheme(value);
  }, []);
  const handleDiffThemeChange = useCallback((id: DiffThemeId) => {
    setDiffThemeId(id);
    localStorage.setItem("diff-theme", id);
  }, []);

  const clearCommentTarget = useCallback(() => {
    setCommentTarget(null);
    setSelectedLines(null);
  }, []);

  const openCommentTarget = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<AnnotationMeta> }) => {
      if (range == null || context.item.type !== "diff") return;
      const target = {
        itemId: context.item.id,
        path: context.item.fileDiff!.name,
        line: range.start,
        side: selectedRangeSide(range),
        endLine: selectedRangeEndLine(range),
        endSide: selectedRangeEndSide(range),
        range,
      };
      setSelectedLines({ id: context.item.id, range });
      setCommentTarget(target);
    },
    [],
  );

  const addComment = useCallback(
    (body: string) => {
      if (!commentTarget) return;
      if (!isLocal) {
        setCommentThreads((prev) => [...prev, createPendingThread(commentTarget, body)]);
        clearCommentTarget();
        return;
      }
      if (commentsEndpoint == null) {
        clearCommentTarget();
        return;
      }
      apiFetch<ReviewThread>(commentsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: commentTarget.path,
          line: commentTarget.line,
          side: commentTarget.side,
          endLine: commentTarget.endLine,
          endSide: commentTarget.endSide,
          body,
        }),
      })
        .then((thread) => {
          setCommentThreads((prev) => [...prev.filter((t) => t.id !== thread.id), thread]);
          clearCommentTarget();
        })
        .catch(() => {
          clearCommentTarget();
        });
    },
    [clearCommentTarget, commentTarget, commentsEndpoint, isLocal],
  );

  const submitPendingComments = useCallback(async () => {
    if (commentsEndpoint == null || pendingCommentThreads.length === 0 || submittingPendingComments) {
      return;
    }
    setSubmittingPendingComments(true);
    try {
      for (const pendingThread of pendingCommentThreads) {
        const draft = pendingThread.draft;
        if (!draft) continue;
        const submittedThread = await apiFetch<ReviewThread>(commentsEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        setCommentThreads((prev) => [
          ...prev.filter((thread) => thread.id !== pendingThread.id && thread.id !== submittedThread.id),
          submittedThread,
        ]);
      }
    } catch (err) {
      console.error("Failed to submit pending comments:", err);
    } finally {
      setSubmittingPendingComments(false);
    }
  }, [commentsEndpoint, pendingCommentThreads, submittingPendingComments]);

  const deleteComment = useCallback(
    (thread: ReviewThread) => {
      if (thread.pending) {
        setCommentThreads((prev) => prev.filter((current) => current.id !== thread.id));
        return;
      }
      if (!isLocal) return;
      apiFetch(`/api/comments/${encodeURIComponent(thread.id)}`, { method: "DELETE" })
        .then(() => {
          setCommentThreads((prev) => prev.filter((current) => current.id !== thread.id));
        })
        .catch((err) => {
          console.error("Failed to delete comment:", err);
        });
    },
    [isLocal],
  );

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const affectedItemIds = new Set<string>();
    for (const thread of commentThreads) {
      const itemId = filePathToItemId.get(thread.path);
      if (itemId != null) affectedItemIds.add(itemId);
    }
    if (commentTarget) affectedItemIds.add(commentTarget.itemId);
    for (const item of initialItems) affectedItemIds.add(item.id);

    for (const itemId of affectedItemIds) {
      const current = viewer.getItem(itemId);
      if (!current) continue;

      const annotations: DiffLineAnnotation<AnnotationMeta>[] = [];

      for (const thread of commentThreads) {
        if (thread.status !== "open") continue;
        if (filePathToItemId.get(thread.path) !== itemId) continue;
        annotations.push({
          side: thread.side,
          lineNumber: thread.line,
          metadata: { type: "comment", thread },
        });
      }

      if (commentTarget && commentTarget.itemId === itemId) {
        annotations.push({
          side: commentTarget.side,
          lineNumber: commentTarget.line,
          metadata: { type: "input" },
        });
      }

      const changed =
        (current.annotations?.length ?? 0) !== annotations.length ||
        JSON.stringify(current.annotations) !== JSON.stringify(annotations);
      if (!changed) continue;

      viewer.updateItem({
        ...current,
        version: (current.version ?? 0) + 1,
        annotations: annotations.length > 0 ? annotations : undefined,
      });
    }
  }, [commentThreads, commentTarget, initialItems, filePathToItemId]);

  const codeViewOptions = useMemo(
    () => ({
      theme: selectedDiffTheme.theme,
      themeType: selectedDiffTheme.themeType,
      diffStyle,
      hunkSeparators: "line-info" as const,
      stickyHeaders: true,
      disableBackground: !showBackground,
      disableLineNumbers: !showLineNumbers,
      overflow: (wordWrap ? "wrap" : "scroll") as "wrap" | "scroll",
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: openCommentTarget,
      onLineSelectionEnd: openCommentTarget,
      layout: { paddingTop: 12, paddingBottom: 12, gap: 12 },
    }),
    [
      selectedDiffTheme.theme,
      selectedDiffTheme.themeType,
      diffStyle,
      showBackground,
      showLineNumbers,
      wordWrap,
      openCommentTarget,
    ],
  );

  const renderAnnotation = useCallback(
    (annotation: { metadata?: AnnotationMeta }) => (
      <DiffAnnotation
        annotation={annotation}
        onSubmitComment={addComment}
        onCancelComment={clearCommentTarget}
        onDeleteComment={deleteComment}
      />
    ),
    [addComment, clearCommentTarget, deleteComment],
  );

  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      const isCollapsed = item.collapsed ?? false;
      return (
        <button
          type="button"
          title={isCollapsed ? "Expand file" : "Collapse file"}
          className={`-ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-none p-0 transition-all text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 ${
            isCollapsed ? "" : "rotate-90"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            toggleFileCollapsed(item.id);
          }}
        >
          <ChevronRight size={16} />
        </button>
      );
    },
    [toggleFileCollapsed],
  );

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">Loading diff...</div>
    );
  }

  if (error) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 text-red-600">
        <p>Failed to fetch diff: {error}</p>
        <Link to="/" className="text-blue-500 no-underline">
          Back
        </Link>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 text-neutral-500">
        <p>{isLocal ? "No local changes in the working tree." : "No files changed in this PR."}</p>
        <Link to="/" className="text-blue-500 no-underline">
          Back
        </Link>
      </div>
    );
  }

  const sidebarTreeProps = {
    paths: filePaths,
    files,
    comments: commentThreads,
    onFileActivate: scrollToFile,
    onCommentActivate: scrollToThread,
    onDeleteComment: deleteComment,
  };

  return (
    <div className="flex h-dvh flex-col">
      <DiffToolbar
        allCollapsed={allCollapsed}
        appColorScheme={appColorScheme}
        config={config}
        diffStyle={diffStyle}
        diffThemeId={diffThemeId}
        showBackground={showBackground}
        showLineNumbers={showLineNumbers}
        isLocal={isLocal}
        onColorSchemeChange={handleColorSchemeChange}
        onDiffStyleToggle={() => setDiffStyle((s) => (s === "split" ? "unified" : "split"))}
        onDiffThemeChange={handleDiffThemeChange}
        onSettingsOpenChange={setSettingsOpen}
        onSidebarToggle={openSidebar}
        onSubmitPendingComments={submitPendingComments}
        onToggleAllCollapsed={toggleAllFilesCollapsed}
        pendingCommentCount={pendingCommentThreads.length}
        pullRequestInfo={currentPullRequestInfo}
        wordWrap={wordWrap}
        prUrl={prUrl}
        selectedDiffThemeLabel={selectedDiffTheme.label}
        setShowBackground={setShowBackground}
        setShowLineNumbers={setShowLineNumbers}
        setWordWrap={setWordWrap}
        settingsOpen={settingsOpen}
        sidebarOpen={sidebarOpen}
        submittingPendingComments={submittingPendingComments}
      />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="hidden w-[320px] shrink-0 overflow-hidden border-r border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 md:block">
            <SidebarTree {...sidebarTreeProps} />
          </aside>
        )}
        {mobileSidebarOpen && (
          <Suspense fallback={null}>
            <MobileSidebarDrawer open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
              <SidebarTree {...sidebarTreeProps} onClose={() => setMobileSidebarOpen(false)} />
            </MobileSidebarDrawer>
          </Suspense>
        )}
        <CodeView<AnnotationMeta>
          key={codeViewKey}
          ref={viewerRef}
          initialItems={initialItems}
          selectedLines={selectedLines}
          onSelectedLinesChange={setSelectedLines}
          style={codeViewStyle}
          options={codeViewOptions}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={renderHeaderPrefix}
        />
      </div>
    </div>
  );
}
