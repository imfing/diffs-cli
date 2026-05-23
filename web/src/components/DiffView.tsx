import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  parsePatchFiles,
  type CodeViewItem,
  type DiffLineAnnotation,
  type DiffsThemeNames,
  type FileDiffMetadata,
  type SelectedLineRange,
  type ThemesType,
  type ThemeTypes,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react';
import { CommentInput } from './CommentInput';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  applyColorScheme,
  initialColorScheme,
  isAppColorScheme,
  persistColorScheme,
  type AppColorScheme,
} from '@/lib/colorScheme';
import type { GitStatusEntry } from '@pierre/trees';
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import {
  IconChevronRight as ChevronRight,
  IconExternalLink as ExternalLink,
  IconFolder as FolderTree,
  IconLayoutColumns as SplitView,
  IconLayoutList as UnifiedView,
  IconLayoutSidebar as PanelLeft,
  IconMessagePlus as MessageSquarePlus,
  IconSearch as Search,
  IconSettings as Settings,
  IconX as X,
} from '@tabler/icons-react';
import { FoldVertical, UnfoldVertical } from 'lucide-react';

type DiffStyle = 'split' | 'unified';
type DiffThemeId =
  | 'pierre'
  | 'github'
  | 'dark-plus'
  | 'light-plus'
  | 'one-dark-pro'
  | 'one-light'
  | 'monokai'
  | 'night-owl'
  | 'tokyo-night';

type DiffThemeOption = {
  id: DiffThemeId;
  label: string;
  theme: DiffsThemeNames | ThemesType;
  themeType?: ThemeTypes;
};

type ColorSchemeOption = {
  id: AppColorScheme;
  label: string;
};

type PatchLoadState = {
  error: string | null;
  patch: string | null;
  requestKey: string;
  status: 'loading' | 'loaded' | 'error';
};

type AppConfig = {
  colorScheme?: string;
  cwd: string;
  gitBranch: string;
  githubHost: string;
};

type PendingComment = {
  id: string;
  body: string;
  path: string;
  line: number;
  side: 'additions' | 'deletions';
  itemId: string;
};

type CommentTarget = {
  itemId: string;
  path: string;
  line: number;
  side: 'additions' | 'deletions';
};

type AnnotationMeta =
  | { type: 'input' }
  | { type: 'comment'; comment: PendingComment };

function localDirTitle(cwd: string): string {
  const normalized = cwd.trim().replace(/[\\/]+$/, '');
  if (normalized === '') return 'local';
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized;
}

function localRepoTitle(cwd: string, branch: string): string {
  const dir = localDirTitle(cwd);
  const cleanedBranch = branch.trim();
  return cleanedBranch === '' ? dir : `${dir} (${cleanedBranch})`;
}

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

const diffThemeOptions: readonly DiffThemeOption[] = [
  {
    id: 'pierre',
    label: 'Pierre',
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType: 'system',
  },
  {
    id: 'github',
    label: 'GitHub',
    theme: { dark: 'github-dark', light: 'github-light' },
    themeType: 'system',
  },
  { id: 'dark-plus', label: 'Dark Plus', theme: 'dark-plus' },
  { id: 'light-plus', label: 'Light Plus', theme: 'light-plus' },
  { id: 'one-dark-pro', label: 'One Dark Pro', theme: 'one-dark-pro' },
  { id: 'one-light', label: 'One Light', theme: 'one-light' },
  { id: 'monokai', label: 'Monokai', theme: 'monokai' },
  { id: 'night-owl', label: 'Night Owl', theme: 'night-owl' },
  { id: 'tokyo-night', label: 'Tokyo Night', theme: 'tokyo-night' },
];

const colorSchemeOptions: readonly ColorSchemeOption[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

function SidebarTree({
  paths,
  files,
  onFileActivate,
}: {
  paths: readonly string[];
  files: readonly FileDiffMetadata[];
  onFileActivate: (path: string) => void;
}) {
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const filePathSetRef = useRef(filePathSet);
  const onFileActivateRef = useRef(onFileActivate);

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
    (event: React.MouseEvent<HTMLElement>) => {
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

  return (
    <div className="flex h-full flex-col pt-3">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 pb-1">
        <div className="mr-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" title="Files">
            <FolderTree size={14} />
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          title="Search files"
          aria-pressed={search.isOpen}
          onClick={() => (search.isOpen ? search.close() : search.open(''))}
        >
          <Search size={14} />
        </Button>
      </div>

      {/* Tree */}
      <div className="mt-2 min-h-0 flex-1">
        <FileTree model={model} onClick={handleTreeClick} style={{ height: '100%' }} />
      </div>

      {/* Stats */}
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

const headerIconButtonClass = 'size-7 shrink-0 p-0 text-muted-foreground [&_svg]:size-[15px]';
const headerIconLinkClass = buttonVariants({
  variant: 'ghost',
  size: 'icon-sm',
  className: `${headerIconButtonClass} no-underline`,
});
const settingsRowClass = 'flex items-center justify-between gap-4 py-1.5 text-sm';

function PullRequestUrlForm({
  onNavigate,
  prUrl,
}: {
  onNavigate: (path: string) => void;
  prUrl: string;
}) {
  const [urlInput, setUrlInput] = useState(prUrl);

  function handleUrlSubmit(e: React.FormEvent) {
    e.preventDefault();
    const match = urlInput.match(/(?:https?:\/\/[^/]+\/)?([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (match) {
      const [, o, r, n] = match;
      onNavigate(`/${o}/${r}/pull/${n}`);
    }
  }

  return (
    <form className="group mr-auto flex min-w-0 flex-1 items-center gap-0.5" onSubmit={handleUrlSubmit}>
      <input
        value={urlInput}
        onChange={(e) => setUrlInput(e.target.value)}
        placeholder="https://github.com/org/repo/pull/123"
        className="block h-9 min-w-[24ch] max-w-[440px] flex-1 rounded-md bg-transparent px-2 text-[13px] text-neutral-500 outline-none focus:text-neutral-900 dark:focus:text-neutral-100"
      />
      {urlInput && (
        <button
          type="button"
          className={buttonVariants({
            variant: 'ghost',
            size: 'icon-sm',
            className: 'opacity-0 transition-opacity group-hover:opacity-50 group-focus-within:opacity-50 hover:!opacity-100',
          })}
          onClick={() => setUrlInput('')}
          aria-label="Clear"
        >
          <X size={14} />
        </button>
      )}
      <button type="submit" hidden />
    </form>
  );
}

export function DiffView({ source = 'pr' }: { source?: 'pr' | 'local' } = {}) {
  const { org, repo, number } = useParams<{
    org: string;
    repo: string;
    number: string;
  }>();
  const navigate = useNavigate();

  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split');
  const [diffThemeId, setDiffThemeId] = useState<DiffThemeId>(
    () => (localStorage.getItem('diff-theme') as DiffThemeId) || 'pierre',
  );
  const [appColorScheme, setAppColorScheme] = useState<AppColorScheme>(() => initialColorScheme());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disableBackground, setDisableBackground] = useState(false);
  const [disableLineNumbers, setDisableLineNumbers] = useState(false);
  const [overflow, setOverflow] = useState<'scroll' | 'wrap'>('scroll');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const viewerRef = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  const [pendingComments, setPendingComments] = useState<PendingComment[]>([]);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
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
  }, [isLocal, org, repo, number, requestKey]);

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

  const addComment = useCallback(
    (body: string) => {
      if (!commentTarget) return;
      const comment: PendingComment = {
        id: crypto.randomUUID(),
        body,
        path: commentTarget.path,
        line: commentTarget.line,
        side: commentTarget.side,
        itemId: commentTarget.itemId,
      };
      setPendingComments((prev) => [...prev, comment]);
      setCommentTarget(null);
    },
    [commentTarget],
  );

  const deleteComment = useCallback((commentId: string) => {
    setPendingComments((prev) => prev.filter((c) => c.id !== commentId));
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const affectedItemIds = new Set<string>();
    for (const c of pendingComments) affectedItemIds.add(c.itemId);
    if (commentTarget) affectedItemIds.add(commentTarget.itemId);
    for (const item of initialItems) affectedItemIds.add(item.id);

    for (const itemId of affectedItemIds) {
      const current = viewer.getItem(itemId);
      if (!current) continue;

      const annotations: DiffLineAnnotation<AnnotationMeta>[] = [];

      for (const c of pendingComments) {
        if (c.itemId !== itemId) continue;
        annotations.push({ side: c.side, lineNumber: c.line, metadata: { type: 'comment', comment: c } });
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
  }, [pendingComments, commentTarget, initialItems]);

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
      {/* ── Topbar ── */}
      <header className="flex shrink-0 flex-nowrap items-center gap-2.5 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
        {/* URL input */}
        {isLocal ? (
          <div className="mr-auto min-w-0 truncate px-2 text-[13px] text-neutral-500 dark:text-neutral-400">
            Watching {config.cwd || 'current directory'}
            {config.gitBranch.trim() !== '' ? ` on ${config.gitBranch.trim()}` : ''}
          </div>
        ) : (
          <PullRequestUrlForm key={prUrl} prUrl={prUrl} onNavigate={navigate} />
        )}

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={headerIconButtonClass}
            onClick={() => setSidebarOpen((o) => !o)}
            aria-pressed={sidebarOpen}
            aria-label="Show file tree"
            title="Show file tree"
          >
            <PanelLeft size={14} />
          </Button>

          {!isLocal && (
            <a href={prUrl} target="_blank" rel="noopener noreferrer" className={headerIconLinkClass} aria-label="Open source in new tab" title="Open source in new tab">
              <ExternalLink size={14} />
            </a>
          )}

          <span className="mx-1 h-3 w-px shrink-0 bg-neutral-300 dark:bg-neutral-600" />

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={headerIconButtonClass}
            onClick={() => setDiffStyle((s) => (s === 'split' ? 'unified' : 'split'))}
            aria-label={diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view'}
            title={diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view'}
          >
            {diffStyle === 'split' ? <UnifiedView /> : <SplitView />}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={headerIconButtonClass}
            onClick={() => {
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
            }}
            aria-pressed={allCollapsed}
            aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
            title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
          >
            {allCollapsed ? <UnfoldVertical /> : <FoldVertical />}
          </Button>

          {pendingComments.length > 0 && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                console.log('Submit review:', pendingComments);
              }}
            >
              Submit Review ({pendingComments.length})
            </Button>
          )}

          <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={headerIconButtonClass}
                  aria-label="Settings"
                  title="Settings"
                >
                  <Settings size={14} />
                </Button>
              }
            />
            <PopoverContent align="end" sideOffset={8} className="w-[250px] gap-3 p-3">
              <PopoverHeader>
                <PopoverTitle>Settings</PopoverTitle>
              </PopoverHeader>
              <div className="flex flex-col gap-1">
                <label className={settingsRowClass}>
                  <span>Color scheme</span>
                  <Select
                    value={appColorScheme}
                    onValueChange={(value) => {
                      if (!isAppColorScheme(value)) return;
                      setAppColorScheme(value);
                      persistColorScheme(value);
                    }}
                  >
                    <SelectTrigger size="sm" className="h-7 w-[134px] text-xs">
                      <SelectValue>
                        {(value) =>
                          colorSchemeOptions.find((option) => option.id === value)?.label ?? 'System'
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectGroup>
                        {colorSchemeOptions.map((option) => (
                          <SelectItem key={option.id} value={option.id} className="text-xs">
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                <label className={settingsRowClass}>
                  <span>Diff theme</span>
                  <Select
                    value={diffThemeId}
                    onValueChange={(value) => {
                      const id = value as DiffThemeId;
                      setDiffThemeId(id);
                      localStorage.setItem('diff-theme', id);
                    }}
                  >
                    <SelectTrigger size="sm" className="h-7 w-[134px] text-xs">
                      <SelectValue>
                        {(value) =>
                          diffThemeOptions.find((option) => option.id === value)?.label ?? selectedDiffTheme.label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="end" className="max-h-[260px]">
                      <SelectGroup>
                        {diffThemeOptions.map((option) => (
                          <SelectItem key={option.id} value={option.id} className="text-xs">
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                <label className={settingsRowClass}>
                  <span>Line backgrounds</span>
                  <Switch size="sm" checked={!disableBackground} onCheckedChange={(checked) => setDisableBackground(!checked)} />
                </label>
                <label className={settingsRowClass}>
                  <span>Line numbers</span>
                  <Switch size="sm" checked={!disableLineNumbers} onCheckedChange={(checked) => setDisableLineNumbers(!checked)} />
                </label>
                <label className={settingsRowClass}>
                  <span>Word wrap</span>
                  <Switch size="sm" checked={overflow === 'wrap'} onCheckedChange={(checked) => setOverflow(checked ? 'wrap' : 'scroll')} />
                </label>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="w-[260px] shrink-0 overflow-hidden border-r border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900">
            <SidebarTree
              paths={filePaths}
              files={files}
              onFileActivate={scrollToFile}
            />
          </aside>
        )}
        <CodeView<AnnotationMeta>
          ref={viewerRef}
          initialItems={initialItems}
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
            onGutterUtilityClick(range: SelectedLineRange, context: { item: CodeViewItem<AnnotationMeta> }) {
              setCommentTarget({
                itemId: context.item.id,
                path: context.item.type === 'diff' ? context.item.fileDiff!.name : '',
                line: range.start,
                side: range.side ?? 'additions',
              });
            },
            layout: { paddingTop: 12, paddingBottom: 12, gap: 12 },
          }}
          renderAnnotation={(annotation) => {
            const meta = annotation.metadata;
            if (!meta) return null;
            if (meta.type === 'input') {
              return (
                <CommentInput
                  onSubmit={addComment}
                  onCancel={() => setCommentTarget(null)}
                />
              );
            }
            if (meta.type === 'comment') {
              return (
                <div className="group/comment relative m-2 ml-3 flex max-w-[600px] items-start gap-2.5 rounded-xl border border-amber-200/60 bg-amber-50 bg-clip-padding p-3 font-sans shadow-[0_2px_4px_rgb(0_0_0_/_0.025),0_4px_8px_rgb(0_0_0_/_0.025)] dark:border-amber-500/20 dark:bg-amber-900/20 dark:shadow-[0_2px_4px_rgb(0_0_0_/_0.25),0_4px_8px_rgb(0_0_0_/_0.25)]">
                  <MessageSquarePlus size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="flex-1 text-[14px] text-neutral-800 dark:text-neutral-200">{meta.comment.body}</span>
                  <button
                    type="button"
                    onClick={() => deleteComment(meta.comment.id)}
                    className="absolute -right-2 -top-2 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-400 opacity-0 shadow-sm transition-all hover:border-red-200 hover:bg-red-50 hover:text-red-500 group-hover/comment:opacity-100 dark:border-neutral-600 dark:bg-neutral-800 dark:hover:border-red-700 dark:hover:bg-red-900/40"
                    title="Delete comment"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            }
            return null;
          }}
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
