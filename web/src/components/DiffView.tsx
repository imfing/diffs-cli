import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  parsePatchFiles,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react';
import {
  applyColorScheme,
  initialColorScheme,
  isAppColorScheme,
  persistColorScheme,
  type AppColorScheme,
} from '@/lib/colorScheme';
import {
  IconChevronRight as ChevronRight,
} from '@tabler/icons-react';
import { DiffAnnotation } from './diff-view/DiffAnnotation';
import { DiffToolbar } from './diff-view/DiffToolbar';
import { SidebarTree } from './diff-view/SidebarTree';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from './ui/drawer';
import type {
  AnnotationMeta,
  AppConfig,
  CodeViewLineSelection,
  CommentTarget,
  DiffStyle,
  DiffThemeId,
  PatchLoadState,
  ReviewThread,
} from './diff-view/types';
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
} from './diff-view/helpers';

export function DiffView({ source = 'pr' }: { source?: 'pr' | 'local' } = {}) {
  const { org, repo, number } = useParams<{
    org: string;
    repo: string;
    number: string;
  }>();
  const navigate = useNavigate();

  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split');
  const [diffThemeId, setDiffThemeId] = useState<DiffThemeId>(
    () => {
      const stored = localStorage.getItem('diff-theme');
      return isDiffThemeId(stored) ? stored : 'pierre';
    },
  );
  const [appColorScheme, setAppColorScheme] = useState<AppColorScheme>(() => initialColorScheme());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disableBackground, setDisableBackground] = useState(false);
  const [disableLineNumbers, setDisableLineNumbers] = useState(false);
  const [overflow, setOverflow] = useState<'scroll' | 'wrap'>('scroll');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const viewerRef = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  const [commentThreads, setCommentThreads] = useState<ReviewThread[]>([]);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [config, setConfig] = useState<AppConfig>({ cwd: '', gitBranch: '', githubHost: 'github.com' });

  const isLocal = source === 'local';
  const prUrl = `https://${config.githubHost}/${org}/${repo}/pull/${number}`;
  const pageTitle = isLocal
    ? `${localRepoTitle(config.cwd, config.gitBranch)} - diffs`
    : org && repo && number
      ? `${org}/${repo}/pull/${number} - diffs`
      : 'diffs';
  const requestKey = isLocal ? `local:${config.cwd}` : `${org}/${repo}/${number}`;
  const [patchState, setPatchState] = useState<PatchLoadState>({
    error: null,
    patch: null,
    requestKey,
    status: 'loading',
  });

  useEffect(() => {
    fetch('/api/config')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((nextConfig: AppConfig) => {
        setConfig(nextConfig);
        if (isAppColorScheme(nextConfig.colorScheme)) {
          setAppColorScheme(nextConfig.colorScheme);
        }
        if (isDiffThemeId(nextConfig.diffTheme)) {
          setDiffThemeId(nextConfig.diffTheme);
        }
        if (isDiffStyle(nextConfig.diffStyle)) {
          setDiffStyle(nextConfig.diffStyle);
        }
        if (typeof nextConfig.wordWrap === 'boolean') {
          setOverflow(nextConfig.wordWrap ? 'wrap' : 'scroll');
        }
        if (typeof nextConfig.lineNumbers === 'boolean') {
          setDisableLineNumbers(!nextConfig.lineNumbers);
        }
        if (typeof nextConfig.lineBackgrounds === 'boolean') {
          setDisableBackground(!nextConfig.lineBackgrounds);
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
    if (!isLocal) return;
    fetch('/api/local-comments')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { threads?: ReviewThread[] }) => {
        setCommentThreads(data.threads ?? []);
      })
      .catch(() => {
        setCommentThreads([]);
      });
  }, [isLocal]);

  useEffect(() => {
    let ignore = false;
    let eventSource: EventSource | undefined;
    let fallbackInterval: number | undefined;

    const load = () => {
      const endpoint = isLocal ? '/api/local-diff' : `/api/patch/${org}/${repo}/${number}`;
      fetch(endpoint)
        .then((res) => {
          if (!res.ok) {
            return res.text().then((body) => {
              throw new Error(body || `HTTP ${res.status}`);
            });
          }
          return res.text();
        })
        .then((text) => {
          if (!ignore) {
            setPatchState({
              error: null,
              patch: text,
              requestKey,
              status: 'loaded',
            });
            if (isLocal) loadComments();
          }
        })
        .catch((err: unknown) => {
          if (!ignore) {
            setPatchState({
              error: err instanceof Error ? err.message : String(err),
              patch: null,
              requestKey,
              status: 'error',
            });
          }
        });
    };

    if (!isLocal && (!org || !repo || !number)) return;
    load();
    if (isLocal) {
      eventSource = new EventSource('/api/events');
      eventSource.addEventListener('diff', load);
      fallbackInterval = window.setInterval(load, 30000);
    }

    return () => {
      ignore = true;
      eventSource?.close();
      if (fallbackInterval != null) window.clearInterval(fallbackInterval);
    };
  }, [isLocal, org, repo, number, requestKey, loadComments]);

  const activePatchState = patchState.requestKey === requestKey ? patchState : null;
  const loading = activePatchState == null || activePatchState.status === 'loading';
  const error = activePatchState?.status === 'error' ? activePatchState.error : null;

  const files = useMemo<FileDiffMetadata[]>(() => {
    if (activePatchState?.status !== 'loaded' || !activePatchState.patch) return [];
    const parsed = parsePatchFiles(activePatchState.patch);
    return parsed.flatMap((p) => p.files);
  }, [activePatchState]);

  const filePaths = useMemo(() => [...new Set(files.map((f) => f.name))], [files]);
  const initialItems = useMemo<CodeViewItem<AnnotationMeta>[]>(
    () => files.map((f, i) => ({ id: `diff:${f.name}:${i}`, type: 'diff' as const, fileDiff: f })),
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
      viewerRef.current?.scrollTo({ type: 'item', id: itemId, align: 'start', behavior: 'smooth-auto' });
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
      viewerRef.current?.scrollTo({ type: 'range', id: itemId, range, align: 'center', behavior: 'smooth-auto' });
    },
    [filePathToItemId],
  );
  const openSidebar = useCallback(() => {
    if (window.matchMedia('(max-width: 767px)').matches) {
      setMobileSidebarOpen(true);
      return;
    }
    setSidebarOpen((open) => !open);
  }, []);
  const activateMobileFile = useCallback(
    (path: string) => {
      scrollToFile(path);
      setMobileSidebarOpen(false);
    },
    [scrollToFile],
  );
  const activateMobileComment = useCallback(
    (thread: ReviewThread) => {
      scrollToThread(thread);
      setMobileSidebarOpen(false);
    },
    [scrollToThread],
  );
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
    localStorage.setItem('diff-theme', id);
  }, []);

  const clearCommentTarget = useCallback(() => {
    setCommentTarget(null);
    setSelectedLines(null);
  }, []);

  const openCommentTarget = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<AnnotationMeta> }) => {
      if (range == null || context.item.type !== 'diff') return;
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
      if (isLocal) {
        fetch('/api/local-comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: commentTarget.path,
            line: commentTarget.line,
            side: commentTarget.side,
            endLine: commentTarget.endLine,
            endSide: commentTarget.endSide,
            body,
          }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then((thread: ReviewThread) => {
            setCommentThreads((prev) => [...prev.filter((t) => t.id !== thread.id), thread]);
            clearCommentTarget();
          })
          .catch(() => {
            clearCommentTarget();
          });
        return;
      }
      const now = new Date().toISOString();
      const thread: ReviewThread = {
        id: crypto.randomUUID(),
        provider: 'local',
        branch: '',
        path: commentTarget.path,
        line: commentTarget.line,
        side: commentTarget.side,
        endLine: commentTarget.endLine,
        endSide: commentTarget.endSide,
        status: 'open',
        comments: [{ id: crypto.randomUUID(), author: 'local', body, createdAt: now }],
      };
      setCommentThreads((prev) => [...prev, thread]);
      clearCommentTarget();
    },
    [clearCommentTarget, commentTarget, isLocal],
  );

  const resolveThread = useCallback(
    (threadId: string) => {
      if (isLocal) {
        fetch(`/api/local-comments/${threadId}/resolve`, { method: 'POST' })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then((thread: ReviewThread) => {
            setCommentThreads((prev) => prev.map((t) => (t.id === thread.id ? thread : t)));
          })
          .catch(() => {
            setCommentThreads((prev) => prev.filter((t) => t.id !== threadId));
          });
        return;
      }
      setCommentThreads((prev) => prev.filter((t) => t.id !== threadId));
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
        if (thread.status !== 'open') continue;
        if (filePathToItemId.get(thread.path) !== itemId) continue;
        annotations.push({ side: thread.side, lineNumber: thread.line, metadata: { type: 'comment', thread } });
      }

      if (commentTarget && commentTarget.itemId === itemId) {
        annotations.push({ side: commentTarget.side, lineNumber: commentTarget.line, metadata: { type: 'input' } });
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

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 text-red-600">
        <p>Failed to fetch diff: {error}</p>
        <Link to="/" className="text-blue-500 no-underline">Back</Link>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 text-neutral-500">
        <p>{isLocal ? 'No local changes in the working tree.' : 'No files changed in this PR.'}</p>
        <Link to="/" className="text-blue-500 no-underline">Back</Link>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <DiffToolbar
        allCollapsed={allCollapsed}
        appColorScheme={appColorScheme}
        commentCount={commentThreads.length}
        config={config}
        diffStyle={diffStyle}
        diffThemeId={diffThemeId}
        disableBackground={disableBackground}
        disableLineNumbers={disableLineNumbers}
        isLocal={isLocal}
        onColorSchemeChange={handleColorSchemeChange}
        onDiffStyleToggle={() => setDiffStyle((s) => (s === 'split' ? 'unified' : 'split'))}
        onDiffThemeChange={handleDiffThemeChange}
        onNavigate={navigate}
        onSettingsOpenChange={setSettingsOpen}
        onSidebarToggle={openSidebar}
        onSubmitReview={() => {
          console.log('Submit review:', commentThreads);
        }}
        onToggleAllCollapsed={toggleAllFilesCollapsed}
        overflow={overflow}
        prUrl={prUrl}
        selectedDiffThemeLabel={selectedDiffTheme.label}
        setDisableBackground={setDisableBackground}
        setDisableLineNumbers={setDisableLineNumbers}
        setOverflow={setOverflow}
        settingsOpen={settingsOpen}
        sidebarOpen={sidebarOpen || mobileSidebarOpen}
      />

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="hidden w-[320px] shrink-0 overflow-hidden border-r border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 md:block">
            <SidebarTree
              paths={filePaths}
              files={files}
              comments={commentThreads}
              onFileActivate={scrollToFile}
              onCommentActivate={scrollToThread}
            />
          </aside>
        )}
        <Drawer open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <DrawerContent className="border-neutral-200 bg-neutral-50 p-0 dark:border-neutral-700 dark:bg-neutral-900 md:hidden">
            <DrawerHeader className="sr-only">
              <DrawerTitle>Sidebar</DrawerTitle>
              <DrawerDescription>Browse files, comments, and diff stats.</DrawerDescription>
            </DrawerHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              <SidebarTree
                paths={filePaths}
                files={files}
                comments={commentThreads}
                onFileActivate={activateMobileFile}
                onCommentActivate={activateMobileComment}
              />
            </div>
          </DrawerContent>
        </Drawer>
        <CodeView<AnnotationMeta>
          ref={viewerRef}
          initialItems={initialItems}
          selectedLines={selectedLines}
          onSelectedLinesChange={setSelectedLines}
          style={{ flex: 1, overflow: 'auto' }}
          options={{
            theme: selectedDiffTheme.theme,
            themeType: selectedDiffTheme.themeType,
            diffStyle,
            hunkSeparators: 'line-info',
            stickyHeaders: true,
            disableBackground,
            disableLineNumbers,
            overflow,
            enableGutterUtility: true,
            enableLineSelection: true,
            onGutterUtilityClick(range: SelectedLineRange, context: { item: CodeViewItem<AnnotationMeta> }) {
              openCommentTarget(range, context);
            },
            onLineSelectionEnd(range: SelectedLineRange | null, context: { item: CodeViewItem<AnnotationMeta> }) {
              openCommentTarget(range, context);
            },
            layout: { paddingTop: 12, paddingBottom: 12, gap: 12 },
          }}
          renderAnnotation={(annotation) => (
            <DiffAnnotation
              annotation={annotation}
              onSubmitComment={addComment}
              onCancelComment={clearCommentTarget}
              onResolveThread={resolveThread}
            />
          )}
          renderHeaderPrefix={(item) => {
            const isCollapsed = item.collapsed ?? false;
            return (
              <button
                type="button"
                title={isCollapsed ? 'Expand file' : 'Collapse file'}
                className={`-ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-none p-0 transition-all text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 ${
                  isCollapsed ? '' : 'rotate-90'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFileCollapsed(item.id);
                }}
              >
                <ChevronRight size={16} />
              </button>
            );
          }}
        />
      </div>
    </div>
  );
}
