import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useRef,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
import { useParams, useSearchParams, Link } from "react-router";
import {
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewScrollBehavior,
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
  resolveColorScheme,
  storedColorScheme,
  watchSystemColorScheme,
  type AppColorScheme,
} from "@/lib/colorScheme";
import {
  IconAlertCircle,
  IconCheck,
  IconChecks,
  IconChevronRight,
  IconExternalLink,
  IconFileX,
} from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DiffAnnotation } from "./diff-view/DiffAnnotation";
import { DiffStatusScreen } from "./diff-view/DiffStatusScreen";
import { DiffToolbar } from "./diff-view/DiffToolbar";
import { FileActionsMenu } from "./diff-view/FileActionsMenu";
import { ShortcutsDialog } from "./diff-view/ShortcutsDialog";
import { SidebarTree } from "./diff-view/SidebarTree";
import type {
  AnnotationMeta,
  AppConfig,
  CodeViewLineSelection,
  CommentTarget,
  DiffOrderBy,
  DiffOrderDir,
  DiffSettingsProps,
  DiffStyle,
  DiffThemeId,
  PendingCommentDraft,
  PatchLoadState,
  PullRequestInfo,
  ReviewThread,
} from "./diff-view/types";
import {
  diffThemeOptions,
  isDiffOrderBy,
  isDiffOrderDir,
  isDiffStyle,
  isDiffThemeId,
  localRepoTitle,
  prDiffPathFromUrl,
  selectedRangeEndLine,
  selectedRangeEndSide,
  selectedRangeSide,
  sortFiles,
  splitPatchByFile,
  threadEndLine,
  threadEndSide,
} from "./diff-view/helpers";
import { decodeStoredBool, usePersistentState } from "./diff-view/usePersistentState";
import { apiFetch } from "@/lib/api";
import { DIFF_SURFACE_FONT_SIZE } from "@/lib/diffTypography";
import { exportDiffToHtml } from "@/lib/exportHtml";
import { DEFAULT_CODE_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, prependFontFamily } from "@/lib/fonts";

const MobileSidebarDrawer = lazy(() => import("./diff-view/MobileSidebarDrawer"));

const codeViewStyle = {
  flex: 1,
  overflow: "auto" as const,
  scrollbarGutter: "stable" as const,
  "--diffs-font-size": DIFF_SURFACE_FONT_SIZE,
} as CSSProperties;

const STORAGE_DIFF_THEME = "diff-theme";
const STORAGE_DIFF_STYLE = "diffs-diff-style";
const STORAGE_ORDER_BY = "diffs-order-by";
const STORAGE_ORDER_DIR = "diffs-order-dir";
const STORAGE_WORD_WRAP = "diffs-word-wrap";
const STORAGE_LINE_NUMBERS = "diffs-line-numbers";
const STORAGE_LINE_BACKGROUNDS = "diffs-line-backgrounds";
const STORAGE_COLLAPSE_REMOVALS = "diffs-collapse-removals";
const STORAGE_HIDE_REVIEWED = "diffs-hide-reviewed";

// Window after a programmatic scroll during which the cursor isn't re-synced.
const PROGRAMMATIC_SCROLL_SETTLE_MS = 250;
const EDITABLE_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

// FNV-1a hash, folded to base36.
function fnv1a(build: (feed: (s: string) => void) => void): string {
  let h = 0x811c9dc5;
  build((s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  });
  return (h >>> 0).toString(36);
}

function patchCacheKeyPrefix(patch: string): string {
  return fnv1a((feed) => feed(patch));
}

function readSessionJson<T>(key: string, parse: (raw: unknown) => T, fallback: () => T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? parse(JSON.parse(raw)) : fallback();
  } catch {
    return fallback();
  }
}

function readCollapsedPaths(key: string): Set<string> {
  return readSessionJson(
    key,
    (raw) => new Set(raw as string[]),
    () => new Set(),
  );
}

function persistCollapsedPaths(key: string, paths: Set<string>) {
  sessionStorage.setItem(key, JSON.stringify([...paths]));
}

// Reviewed state maps path -> diff signature; any change to the diff auto-clears it.
function readReviewedSignatures(key: string): Map<string, string> {
  return readSessionJson(
    key,
    (raw) =>
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? new Map(Object.entries(raw as Record<string, string>))
        : new Map(),
    () => new Map(),
  );
}

function persistReviewedSignatures(key: string, signatures: Map<string, string>) {
  sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(signatures)));
}

function fileDiffSignature(file: FileDiffMetadata): string {
  return fnv1a((feed) => {
    feed(file.prevObjectId ?? "");
    feed("..");
    feed(file.newObjectId ?? "");
    // Object IDs are zeroed for working-tree diffs, so also fold content lines (bounded by diff size).
    for (const hunk of file.hunks) {
      feed("\n@");
      feed(hunk.hunkSpecs ?? "");
    }
    for (const line of file.deletionLines) {
      feed("\n-");
      feed(line);
    }
    for (const line of file.additionLines) {
      feed("\n+");
      feed(line);
    }
  });
}

// Single source of truth for collapse state; routes all three reasons (manual, reviewed,
// collapse-removals) through here so they don't clobber each other.
function computeCollapsed(
  file: FileDiffMetadata,
  manualCollapsed: Set<string>,
  reviewedSignatures: Map<string, string>,
  signature: string | undefined,
  collapseRemovals: boolean,
): boolean {
  const isReviewed = signature != null && reviewedSignatures.get(file.name) === signature;
  return (
    manualCollapsed.has(file.name) || isReviewed || (collapseRemovals && file.type === "deleted")
  );
}

function applyConfigFontFamilies(config: AppConfig) {
  const root = document.documentElement;
  const uiFontFamily = prependFontFamily(config.uiFontFamily, DEFAULT_UI_FONT_FAMILY);
  const codeFontFamily = prependFontFamily(config.codeFontFamily, DEFAULT_CODE_FONT_FAMILY);
  const fontVars = [
    ["--font-sans", uiFontFamily],
    ["--font-mono", codeFontFamily],
    ["--diffs-font-family", codeFontFamily],
  ] as const;

  for (const [name, value] of fontVars) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}

function annotationsChanged(
  current: readonly { lineNumber: number; side?: string; metadata?: AnnotationMeta }[] | undefined,
  next: readonly { lineNumber: number; side?: string; metadata?: AnnotationMeta }[],
): boolean {
  const curLen = current?.length ?? 0;
  if (curLen !== next.length) return true;
  if (curLen === 0) return false;
  for (let i = 0; i < curLen; i++) {
    const a = current![i];
    const b = next[i];
    if (a.side !== b.side || a.lineNumber !== b.lineNumber) return true;
    if (a.metadata?.type !== b.metadata?.type) return true;
    if (
      a.metadata?.type === "comment" &&
      b.metadata?.type === "comment" &&
      a.metadata.thread.id !== b.metadata.thread.id
    )
      return true;
  }
  return false;
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

function pullRequestHeaderState(info: PullRequestInfo): { label: string; className: string } {
  if (info.merged) {
    return { label: "Merged", className: "bg-purple-500/10 text-purple-600 dark:text-purple-400" };
  }
  if (info.state.toLowerCase() === "closed") {
    return { label: "Closed", className: "bg-red-500/10 text-red-600 dark:text-red-400" };
  }
  if (info.draft) {
    return {
      label: "Draft",
      className: "bg-neutral-500/10 text-neutral-600 dark:text-neutral-400",
    };
  }
  return { label: "Open", className: "bg-green-500/10 text-green-600 dark:text-green-400" };
}

export function DiffView({ source = "pr" }: { source?: "pr" | "local" | "branch" } = {}) {
  const { org, repo, number } = useParams<{
    org: string;
    repo: string;
    number: string;
  }>();
  const [searchParams] = useSearchParams();
  const baseRef = source === "branch" ? (searchParams.get("base") ?? "") : "";
  const includeDirty = source === "branch" && searchParams.get("dirty") === "1";

  const [diffStyle, setDiffStyle, setDiffStyleLocal] = usePersistentState<DiffStyle>(
    STORAGE_DIFF_STYLE,
    "split",
    (r) => (isDiffStyle(r) ? r : null),
  );
  const [orderBy, setOrderBy] = usePersistentState<DiffOrderBy>(STORAGE_ORDER_BY, "path", (r) =>
    isDiffOrderBy(r) ? r : null,
  );
  const [orderDir, setOrderDir] = usePersistentState<DiffOrderDir>(STORAGE_ORDER_DIR, "asc", (r) =>
    isDiffOrderDir(r) ? r : null,
  );
  const [diffThemeId, setDiffThemeId, setDiffThemeLocal] = usePersistentState<DiffThemeId>(
    STORAGE_DIFF_THEME,
    "pierre",
    (r) => (isDiffThemeId(r) ? r : null),
  );
  const [showBackground, setShowBackground, setShowBackgroundLocal] = usePersistentState(
    STORAGE_LINE_BACKGROUNDS,
    true,
    decodeStoredBool,
  );
  const [showLineNumbers, setShowLineNumbers, setShowLineNumbersLocal] = usePersistentState(
    STORAGE_LINE_NUMBERS,
    true,
    decodeStoredBool,
  );
  const [wordWrap, setWordWrap, setWordWrapLocal] = usePersistentState(
    STORAGE_WORD_WRAP,
    false,
    decodeStoredBool,
  );
  const [collapseRemovals, setCollapseRemovals] = usePersistentState(
    STORAGE_COLLAPSE_REMOVALS,
    false,
    decodeStoredBool,
  );
  const [hideReviewed, setHideReviewed] = usePersistentState(
    STORAGE_HIDE_REVIEWED,
    false,
    decodeStoredBool,
  );
  const [appColorScheme, setAppColorScheme] = useState<AppColorScheme>(() => initialColorScheme());
  const [systemColorScheme, setSystemColorScheme] = useState(() => resolveColorScheme("system"));
  const [allCollapsedOverride, setAllCollapsed] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [submittingPendingComments, setSubmittingPendingComments] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [repoContext, setRepoContext] = useState<{
    repoUrl?: string;
    prUrl?: string;
    branchBase?: string;
  } | null>(null);
  const repoContextRequested = useRef(false);
  const viewerRef = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  const codeViewAreaRef = useRef<HTMLDivElement>(null);
  const currentFileRef = useRef<string | null>(null);
  const programmaticScrollAtRef = useRef(0);
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
  const isBranch = source === "branch";
  const usesLocalStore = isLocal || isBranch;
  const sessionKey = isLocal
    ? "local"
    : isBranch
      ? `branch:${baseRef}`
      : `pr:${org}/${repo}/${number}`;
  const scrollStorageKey = `diffs-scroll:${sessionKey}`;
  const collapsedStorageKey = `diffs-collapsed:${sessionKey}`;
  const reviewedStorageKey = `diffs-reviewed:${sessionKey}`;
  const prUrl =
    org && repo && number ? `https://${config.githubHost}/${org}/${repo}/pull/${number}` : "";
  const commentsEndpoint = usesLocalStore
    ? "/api/comments"
    : org && repo && number
      ? `/api/comments?org=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}&number=${encodeURIComponent(number)}`
      : null;
  const pullRequestInfoEndpoint =
    !usesLocalStore && org && repo && number
      ? `/api/pull/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`
      : null;
  const baseTitle = isBranch
    ? `${baseRef || "base"} ← ${config.gitBranch.trim() || "HEAD"}`
    : isLocal
      ? localRepoTitle(config.cwd, config.gitBranch)
      : org && repo && number
        ? `${org}/${repo}/pull/${number}`
        : "diffs";
  const pageTitle = baseTitle === "diffs" ? "diffs" : `${baseTitle} - diffs`;
  const [patchState, setPatchState] = useState<PatchLoadState>({
    error: null,
    patch: null,
    status: "loading",
  });

  useEffect(() => {
    let ignore = false;
    apiFetch<AppConfig>("/api/config")
      .then((nextConfig) => {
        if (ignore) return;
        applyConfigFontFamilies(nextConfig);
        setConfig(nextConfig);
        const unset = (key: string) => localStorage.getItem(key) == null;
        if (isAppColorScheme(nextConfig.colorScheme) && storedColorScheme() == null) {
          setAppColorScheme(nextConfig.colorScheme);
        }
        if (isDiffThemeId(nextConfig.diffTheme) && unset(STORAGE_DIFF_THEME)) {
          setDiffThemeLocal(nextConfig.diffTheme);
        }
        if (isDiffStyle(nextConfig.diffStyle) && unset(STORAGE_DIFF_STYLE)) {
          setDiffStyleLocal(nextConfig.diffStyle);
        }
        if (typeof nextConfig.wordWrap === "boolean" && unset(STORAGE_WORD_WRAP)) {
          setWordWrapLocal(nextConfig.wordWrap);
        }
        if (typeof nextConfig.lineNumbers === "boolean" && unset(STORAGE_LINE_NUMBERS)) {
          setShowLineNumbersLocal(nextConfig.lineNumbers);
        }
        if (typeof nextConfig.lineBackgrounds === "boolean" && unset(STORAGE_LINE_BACKGROUNDS)) {
          setShowBackgroundLocal(nextConfig.lineBackgrounds);
        }
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [
    setDiffStyleLocal,
    setDiffThemeLocal,
    setShowBackgroundLocal,
    setShowLineNumbersLocal,
    setWordWrapLocal,
  ]);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    applyColorScheme(appColorScheme);
  }, [appColorScheme]);

  useEffect(() => watchSystemColorScheme(setSystemColorScheme), []);

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
      const endpoint = isBranch
        ? `/api/branch-diff?base=${encodeURIComponent(baseRef)}${includeDirty ? "&dirty=1" : ""}`
        : isLocal
          ? "/api/local-diff"
          : `/api/patch/${org}/${repo}/${number}`;
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

    if (isBranch && baseRef === "") {
      return;
    }
    if (!usesLocalStore && (!org || !repo || !number)) return;
    load();
    if (usesLocalStore) {
      eventSource = new EventSource("/api/events");
      eventSource.addEventListener("diff", load);
      fallbackInterval = window.setInterval(load, 30000);
    }

    return () => {
      ignore = true;
      eventSource?.close();
      if (fallbackInterval != null) window.clearInterval(fallbackInterval);
    };
  }, [isLocal, isBranch, usesLocalStore, baseRef, includeDirty, org, repo, number]);

  useEffect(() => {
    if (pullRequestInfoEndpoint == null) return;
    let ignore = false;
    apiFetch<PullRequestInfo>(pullRequestInfoEndpoint)
      .then((info) => {
        if (!ignore) setPullRequestInfo({ endpoint: pullRequestInfoEndpoint, info });
      })
      .catch(() => {
        if (!ignore)
          setPullRequestInfo((current) =>
            current?.endpoint === pullRequestInfoEndpoint ? null : current,
          );
      });
    return () => {
      ignore = true;
    };
  }, [pullRequestInfoEndpoint]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const effectivePatchState: PatchLoadState = useMemo(
    () =>
      isBranch && baseRef === ""
        ? {
            error: "missing `base` query parameter",
            patch: null,
            status: "error",
          }
        : patchState,
    [baseRef, isBranch, patchState],
  );
  const loading = effectivePatchState.status === "loading";
  const error = effectivePatchState.status === "error" ? effectivePatchState.error : null;

  const files = useMemo<FileDiffMetadata[]>(() => {
    if (effectivePatchState.status !== "loaded" || !effectivePatchState.patch) return [];
    const parsed = parsePatchFiles(
      effectivePatchState.patch,
      patchCacheKeyPrefix(effectivePatchState.patch),
    );
    return sortFiles(
      parsed.flatMap((p) => p.files),
      orderBy,
      orderDir,
    );
  }, [effectivePatchState, orderBy, orderDir]);
  const fileSignatures = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of files) if (!map.has(f.name)) map.set(f.name, fileDiffSignature(f));
    return map;
  }, [files]);
  const filePatchSections = useMemo(
    () => splitPatchByFile(effectivePatchState.patch),
    [effectivePatchState.patch],
  );
  const loadRepoContext = useCallback(() => {
    if (!usesLocalStore || repoContextRequested.current) return;
    repoContextRequested.current = true;
    apiFetch<{ repoUrl?: string; prUrl?: string; branchBase?: string }>("/api/repo-context")
      .then(setRepoContext)
      .catch(() => {
        repoContextRequested.current = false;
      });
  }, [usesLocalStore]);
  const shouldLoadRepoContext = usesLocalStore && effectivePatchState.status === "loaded";
  useEffect(() => {
    if (shouldLoadRepoContext) loadRepoContext();
  }, [shouldLoadRepoContext, loadRepoContext]);
  // Render-time reset pattern: resyncs synchronously when the storage key changes (e.g. switching PRs).
  const [reviewed, setReviewed] = useState<{ key: string; map: Map<string, string> }>(() => ({
    key: reviewedStorageKey,
    map: readReviewedSignatures(reviewedStorageKey),
  }));
  if (reviewed.key !== reviewedStorageKey) {
    setReviewed({ key: reviewedStorageKey, map: readReviewedSignatures(reviewedStorageKey) });
  }
  const hiddenReviewedNames = useMemo(() => {
    const names = new Set<string>();
    if (!hideReviewed) return names;
    for (const f of files) {
      const sig = fileSignatures.get(f.name);
      if (sig != null && reviewed.map.get(f.name) === sig) names.add(f.name);
    }
    return names;
  }, [hideReviewed, files, fileSignatures, reviewed]);
  const visibleFiles = useMemo(
    () =>
      hiddenReviewedNames.size === 0
        ? files
        : files.filter((f) => !hiddenReviewedNames.has(f.name)),
    [files, hiddenReviewedNames],
  );
  // hiddenReviewedKey remounts CodeView (no removeItem API); the scroll-restore effect below
  // restores position after the remount.
  const hiddenReviewedKey = [...hiddenReviewedNames].sort().join("\n");
  const codeViewKey = `${effectivePatchState.patch ?? "empty"}:${orderBy}:${orderDir}:${hiddenReviewedKey}`;
  const pendingCommentThreads = useMemo(
    () => commentThreads.filter((thread) => thread.pending && thread.draft),
    [commentThreads],
  );
  const currentPullRequestInfo =
    pullRequestInfo?.endpoint === pullRequestInfoEndpoint ? pullRequestInfo.info : null;

  const filePaths = useMemo(() => [...new Set(visibleFiles.map((f) => f.name))], [visibleFiles]);
  const initialItems = useMemo<CodeViewItem<AnnotationMeta>[]>(() => {
    const collapsed = readCollapsedPaths(collapsedStorageKey);
    const reviewedSigs = readReviewedSignatures(reviewedStorageKey);
    return files
      .map((f, i) => ({
        id: `diff:${f.name}:${i}`,
        type: "diff" as const,
        fileDiff: f,
        ...(computeCollapsed(
          f,
          collapsed,
          reviewedSigs,
          fileSignatures.get(f.name),
          collapseRemovals,
        )
          ? { collapsed: true }
          : {}),
      }))
      .filter((item) => !hiddenReviewedNames.has(item.fileDiff.name));
  }, [
    files,
    collapsedStorageKey,
    reviewedStorageKey,
    fileSignatures,
    collapseRemovals,
    hiddenReviewedNames,
  ]);
  // Ids use the full-array index to match initialItems; hidden files are omitted so their
  // targets resolve to undefined instead of a stale item.
  const filePathToItemId = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < files.length; i++) {
      const name = files[i].name;
      if (hiddenReviewedNames.has(name) || map.has(name)) continue;
      map.set(name, `diff:${name}:${i}`);
    }
    return map;
  }, [files, hiddenReviewedNames]);
  const selectedDiffTheme = useMemo(
    () => diffThemeOptions.find((option) => option.id === diffThemeId) ?? diffThemeOptions[0],
    [diffThemeId],
  );
  const resolvedAppColorScheme = appColorScheme === "system" ? systemColorScheme : appColorScheme;
  const workerPool = useWorkerPool();
  useEffect(() => {
    void workerPool?.setRenderOptions({ theme: selectedDiffTheme.theme });
  }, [workerPool, selectedDiffTheme.theme]);
  const allCollapsed =
    allCollapsedOverride ??
    (initialItems.length > 0 && initialItems.every((item) => item.collapsed));
  const getCurrentFile = useCallback((): string | null => {
    const area = codeViewAreaRef.current;
    if (!area) return null;
    const headers = area.querySelectorAll<HTMLElement>("[data-diff-file]");
    if (headers.length === 0) return null;
    const areaTop = area.getBoundingClientRect().top;
    let current = headers[0].getAttribute("data-diff-file");
    for (let i = 1; i < headers.length; i++) {
      if (headers[i].getBoundingClientRect().top - areaTop > 8) break;
      current = headers[i].getAttribute("data-diff-file");
    }
    return current;
  }, []);
  useEffect(() => {
    const area = codeViewAreaRef.current;
    if (!area) return;

    let timer = 0;
    let rafId = 0;
    const handleScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      if (
        rafId === 0 &&
        Date.now() - programmaticScrollAtRef.current > PROGRAMMATIC_SCROLL_SETTLE_MS
      ) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          currentFileRef.current = getCurrentFile() ?? currentFileRef.current;
        });
      }
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        sessionStorage.setItem(scrollStorageKey, String(el.scrollTop));
      }, 150);
    };
    area.addEventListener("scroll", handleScroll, { capture: true, passive: true });

    const saved = sessionStorage.getItem(scrollStorageKey);
    if (saved) {
      const target = parseInt(saved, 10);
      if (target > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const scrollEl = area.firstElementChild as HTMLElement;
            if (scrollEl) scrollEl.scrollTop = target;
          });
        });
      }
    }

    return () => {
      area.removeEventListener("scroll", handleScroll, { capture: true });
      if (timer) clearTimeout(timer);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [scrollStorageKey, codeViewKey, getCurrentFile]);
  const scrollToFile = useCallback(
    (path: string, behavior: CodeViewScrollBehavior = "smooth-auto") => {
      const itemId = filePathToItemId.get(path);
      if (itemId == null) return;
      currentFileRef.current = path;
      programmaticScrollAtRef.current = Date.now();
      viewerRef.current?.scrollTo({
        type: "item",
        id: itemId,
        align: "start",
        behavior,
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
  const toggleFileCollapsed = useCallback(
    (itemId: string) => {
      const viewer = viewerRef.current;
      const item = viewer?.getItem(itemId);
      if (item == null) return;
      const nextCollapsed = !item.collapsed;
      viewer!.updateItem({
        ...item,
        version: (item.version ?? 0) + 1,
        collapsed: nextCollapsed,
      });
      if (item.type === "diff" && item.fileDiff) {
        const stored = readCollapsedPaths(collapsedStorageKey);
        if (nextCollapsed) stored.add(item.fileDiff.name);
        else stored.delete(item.fileDiff.name);
        persistCollapsedPaths(collapsedStorageKey, stored);
      }
    },
    [collapsedStorageKey],
  );
  const toggleAllFilesCollapsed = useCallback(() => {
    const next = !allCollapsed;
    setAllCollapsed(next);
    const viewer = viewerRef.current;
    if (!viewer) return;
    const collapsedPaths = new Set<string>();
    for (const item of initialItems) {
      const current = viewer.getItem(item.id);
      if (current && current.collapsed !== next) {
        viewer.updateItem({ ...current, version: (current.version ?? 0) + 1, collapsed: next });
      }
      if (next && item.type === "diff" && item.fileDiff) collapsedPaths.add(item.fileDiff.name);
    }
    persistCollapsedPaths(collapsedStorageKey, collapsedPaths);
  }, [allCollapsed, initialItems, collapsedStorageKey]);
  const toggleReviewed = useCallback(
    (itemId: string) => {
      const viewer = viewerRef.current;
      const item = viewer?.getItem(itemId);
      if (item == null || item.type !== "diff" || !item.fileDiff) return;
      const name = item.fileDiff.name;
      const sig = fileSignatures.get(name);
      if (sig == null) return;
      const map = reviewed.map;
      const nextReviewed = map.get(name) !== sig;
      // Mutates the map in place so the updateItem() call below reads the new value;
      // setReviewed's new wrapper drives future re-renders.
      if (nextReviewed) map.set(name, sig);
      else map.delete(name);
      persistReviewedSignatures(reviewedStorageKey, map);
      setReviewed({ key: reviewedStorageKey, map });
      viewer!.updateItem({
        ...item,
        version: (item.version ?? 0) + 1,
        collapsed: computeCollapsed(
          item.fileDiff,
          readCollapsedPaths(collapsedStorageKey),
          map,
          sig,
          collapseRemovals,
        ),
      });
    },
    [fileSignatures, reviewed, reviewedStorageKey, collapsedStorageKey, collapseRemovals],
  );
  const navigateFile = useCallback(
    (delta: number) => {
      if (visibleFiles.length === 0) return;
      const current = currentFileRef.current ?? getCurrentFile();
      const idx = current ? visibleFiles.findIndex((f) => f.name === current) : -1;
      const nextIdx = idx === -1 ? 0 : Math.max(0, Math.min(visibleFiles.length - 1, idx + delta));
      // Instant so holding `n`/`p` advances immediately, not per animation.
      scrollToFile(visibleFiles[nextIdx].name, "instant");
    },
    [visibleFiles, getCurrentFile, scrollToFile],
  );
  const reviewCurrentFile = useCallback(() => {
    const current = currentFileRef.current ?? getCurrentFile();
    if (current == null) return;
    const itemId = filePathToItemId.get(current);
    if (itemId == null) return;
    // Marking hides the file when "hide reviewed" is on; pre-advance the cursor.
    if (hideReviewed) {
      const sig = fileSignatures.get(current);
      const willHide = sig != null && reviewed.map.get(current) !== sig;
      if (willHide) {
        const idx = visibleFiles.findIndex((f) => f.name === current);
        const next = visibleFiles[idx + 1] ?? visibleFiles[idx - 1];
        currentFileRef.current = next?.name ?? null;
      }
    }
    toggleReviewed(itemId);
  }, [
    getCurrentFile,
    filePathToItemId,
    toggleReviewed,
    hideReviewed,
    fileSignatures,
    reviewed,
    visibleFiles,
  ]);
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || EDITABLE_TAGS.test(target.tagName))) {
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      setShortcutsOpen((open) => !open);
      return;
    }
    if (commentTarget || shortcutsOpen) return;
    switch (e.key) {
      case "n":
        e.preventDefault();
        navigateFile(1);
        break;
      case "p":
        e.preventDefault();
        navigateFile(-1);
        break;
      case "m":
        e.preventDefault();
        reviewCurrentFile();
        break;
    }
  });
  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const handleColorSchemeChange = useCallback((value: AppColorScheme) => {
    setAppColorScheme(value);
    persistColorScheme(value);
  }, []);
  const handleDiffStyleToggle = useCallback(
    () => setDiffStyle(diffStyle === "split" ? "unified" : "split"),
    [diffStyle, setDiffStyle],
  );
  const handleOrderDirToggle = useCallback(
    () => setOrderDir(orderDir === "asc" ? "desc" : "asc"),
    [orderDir, setOrderDir],
  );
  const handleCollapseRemovalsChange = useCallback(
    (value: boolean) => {
      setCollapseRemovals(value);
      const viewer = viewerRef.current;
      if (!viewer) return;
      const manualCollapsed = readCollapsedPaths(collapsedStorageKey);
      for (const item of initialItems) {
        if (item.type !== "diff" || item.fileDiff?.type !== "deleted") continue;
        const current = viewer.getItem(item.id);
        if (!current) continue;
        const next = computeCollapsed(
          item.fileDiff,
          manualCollapsed,
          reviewed.map,
          fileSignatures.get(item.fileDiff.name),
          value,
        );
        if (current.collapsed !== next) {
          viewer.updateItem({ ...current, version: (current.version ?? 0) + 1, collapsed: next });
        }
      }
    },
    [initialItems, collapsedStorageKey, reviewed, fileSignatures, setCollapseRemovals],
  );

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
      if (!usesLocalStore) {
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
    [clearCommentTarget, commentTarget, commentsEndpoint, usesLocalStore],
  );

  const submitPendingComments = useCallback(async () => {
    if (
      commentsEndpoint == null ||
      pendingCommentThreads.length === 0 ||
      submittingPendingComments
    ) {
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
          ...prev.filter(
            (thread) => thread.id !== pendingThread.id && thread.id !== submittedThread.id,
          ),
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
      if (!usesLocalStore) return;
      apiFetch(`/api/comments/${encodeURIComponent(thread.id)}`, { method: "DELETE" })
        .then(() => {
          setCommentThreads((prev) => prev.filter((current) => current.id !== thread.id));
        })
        .catch((err) => {
          console.error("Failed to delete comment:", err);
        });
    },
    [usesLocalStore],
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

      if (!annotationsChanged(current.annotations, annotations)) continue;

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
      themeType:
        selectedDiffTheme.themeType === "system"
          ? resolvedAppColorScheme
          : selectedDiffTheme.themeType,
      diffStyle,
      hunkSeparators: "line-info" as const,
      stickyHeaders: true,
      disableBackground: !showBackground,
      disableLineNumbers: !showLineNumbers,
      overflow: (wordWrap ? "wrap" : "scroll") as "wrap" | "scroll",
      enableGutterUtility: true,
      enableLineSelection: true,
      // Removes gutter "+" button's negative margin (overhangs line, blocks selection); shadow DOM needs unsafeCSS.
      unsafeCSS: "[data-utility-button] { margin-right: 0; }",
      onGutterUtilityClick: openCommentTarget,
      onLineSelectionEnd: openCommentTarget,
      layout: { paddingTop: 0, paddingBottom: 12, gap: 12 },
    }),
    [
      selectedDiffTheme.theme,
      selectedDiffTheme.themeType,
      resolvedAppColorScheme,
      diffStyle,
      showBackground,
      showLineNumbers,
      wordWrap,
      openCommentTarget,
    ],
  );

  const handleExport = useCallback(async () => {
    if (exporting || visibleFiles.length === 0) return;
    setExporting(true);
    try {
      const subtitle = isLocal ? config.cwd : isBranch ? config.gitBranch.trim() : prUrl;
      await exportDiffToHtml({
        files: visibleFiles,
        options: codeViewOptions,
        title: baseTitle,
        subtitle,
        dark: resolvedAppColorScheme === "dark",
        fileName: baseTitle,
        codeFontFamily: config.codeFontFamily,
        uiFontFamily: config.uiFontFamily,
      });
    } catch (err) {
      console.error("Failed to export diff:", err);
    } finally {
      setExporting(false);
    }
  }, [
    exporting,
    visibleFiles,
    baseTitle,
    isLocal,
    isBranch,
    config.cwd,
    config.gitBranch,
    config.codeFontFamily,
    config.uiFontFamily,
    prUrl,
    codeViewOptions,
    resolvedAppColorScheme,
  ]);

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
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={`-ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-none p-0 transition-all text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 ${
                  isCollapsed ? "" : "rotate-90"
                }`}
                aria-label={isCollapsed ? "Expand file" : "Collapse file"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFileCollapsed(item.id);
                }}
              >
                <IconChevronRight size={16} />
              </button>
            }
          />
          <TooltipContent>{isCollapsed ? "Expand file" : "Collapse file"}</TooltipContent>
        </Tooltip>
      );
    },
    [toggleFileCollapsed],
  );

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      if (item.type !== "diff" || !item.fileDiff) return null;
      const sig = fileSignatures.get(item.fileDiff.name);
      const isReviewed = sig != null && reviewed.map.get(item.fileDiff.name) === sig;
      return (
        <div className="flex items-center gap-1" data-diff-file={item.fileDiff.name}>
          <label
            title="Mark file as reviewed (collapses it) · shortcut: m"
            className={`inline-flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-0.5 text-xs transition-colors ${
              isReviewed
                ? "text-green-600 dark:text-green-400"
                : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <span
              className={`inline-flex size-4 items-center justify-center rounded border transition-colors ${
                isReviewed
                  ? "border-green-600 bg-green-600 text-white dark:border-green-500 dark:bg-green-500"
                  : "border-neutral-300 dark:border-neutral-600"
              }`}
            >
              {isReviewed && <IconCheck size={12} stroke={3} />}
            </span>
            Reviewed
            <input
              type="checkbox"
              className="sr-only"
              checked={isReviewed}
              onChange={() => toggleReviewed(item.id)}
            />
          </label>
          <FileActionsMenu
            path={item.fileDiff.name}
            diffText={filePatchSections.get(item.fileDiff.name)}
          />
        </div>
      );
    },
    [fileSignatures, reviewed, toggleReviewed, filePatchSections],
  );

  const renderCodeViewHeader = useCallback(() => {
    if (usesLocalStore || !currentPullRequestInfo) return null;
    const info = currentPullRequestInfo;
    const state = pullRequestHeaderState(info);
    return (
      <div className="mb-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium" title={info.title}>
            {info.title}
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 font-medium leading-none ${state.className}`}
          >
            {state.label}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-500 dark:text-neutral-400">
          {info.author !== "" && <span className="shrink-0">{info.author}</span>}
          {info.baseRef !== "" && info.headRef !== "" && (
            <span className="flex min-w-0 shrink items-center gap-1">
              <span className="truncate">{info.baseRef}</span>
              <span aria-hidden="true">←</span>
              <span className="truncate">{info.headRef}</span>
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            <span>{info.changedFiles} files</span>
            <span className="text-green-600 dark:text-green-400">+{info.additions}</span>
            <span className="text-red-600 dark:text-red-400">−{info.deletions}</span>
          </span>
        </div>
      </div>
    );
  }, [usesLocalStore, currentPullRequestInfo]);

  const renderCodeViewFooter = useCallback(() => {
    if (pendingCommentThreads.length === 0) return null;
    const count = pendingCommentThreads.length;
    return (
      <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
        <span className="text-neutral-500 dark:text-neutral-400">
          {count} pending {count === 1 ? "comment" : "comments"}
        </span>
        <button
          type="button"
          className={buttonVariants({ size: "sm" })}
          onClick={submitPendingComments}
          disabled={submittingPendingComments}
        >
          {submittingPendingComments ? "Submitting..." : "Submit"}
        </button>
      </div>
    );
  }, [pendingCommentThreads, submitPendingComments, submittingPendingComments]);

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">Loading diff...</div>
    );
  }

  if (error) {
    return (
      <DiffStatusScreen icon={<IconAlertCircle />} title="Failed to load diff" description={error}>
        <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Back
        </Link>
      </DiffStatusScreen>
    );
  }

  if (files.length === 0) {
    const emptyTitle = isBranch
      ? "No commits ahead"
      : isLocal
        ? "No file changes yet"
        : "No files changed";
    const emptyMessage = isBranch
      ? `No commits ahead of ${baseRef || "base"}.`
      : isLocal
        ? "The latest diffs are no longer available."
        : "This pull request doesn't change any files.";
    return (
      <DiffStatusScreen icon={<IconFileX />} title={emptyTitle} description={emptyMessage}>
        {isLocal && repoContext?.branchBase ? (
          <Link
            to={`/branch?base=${encodeURIComponent(repoContext.branchBase)}`}
            className={buttonVariants({ size: "sm" })}
          >
            View branch diff
          </Link>
        ) : !isLocal && !isBranch && prUrl !== "" ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: "sm" })}
          >
            <IconExternalLink />
            Open in browser
          </a>
        ) : (
          <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Back
          </Link>
        )}
      </DiffStatusScreen>
    );
  }

  const githubRepoUrl =
    !usesLocalStore && org && repo
      ? `https://${config.githubHost}/${org}/${repo}`
      : repoContext?.repoUrl;
  const githubPrUrl = usesLocalStore ? repoContext?.prUrl : prUrl || undefined;
  const prDiffPath =
    usesLocalStore && repoContext?.prUrl ? prDiffPathFromUrl(repoContext.prUrl) : undefined;
  const branchDiffPath =
    isLocal && repoContext?.branchBase
      ? `/branch?base=${encodeURIComponent(repoContext.branchBase)}`
      : undefined;
  const localDiffPath = isBranch ? "/local" : undefined;

  const sidebarTreeProps = {
    paths: filePaths,
    files: visibleFiles,
    comments: commentThreads,
    onFileActivate: scrollToFile,
    onCommentActivate: scrollToThread,
    onDeleteComment: deleteComment,
    colorScheme: resolvedAppColorScheme,
  };

  const settingsProps: DiffSettingsProps = {
    appColorScheme,
    onColorSchemeChange: handleColorSchemeChange,
    diffStyle,
    onDiffStyleToggle: handleDiffStyleToggle,
    orderBy,
    orderDir,
    onOrderByChange: setOrderBy,
    onOrderDirToggle: handleOrderDirToggle,
    diffThemeId,
    onDiffThemeChange: setDiffThemeId,
    selectedDiffThemeLabel: selectedDiffTheme.label,
    showBackground,
    setShowBackground,
    showLineNumbers,
    setShowLineNumbers,
    wordWrap,
    setWordWrap,
    collapseRemovals,
    setCollapseRemovals: handleCollapseRemovalsChange,
    hideReviewed,
    setHideReviewed,
    onShortcutsOpen: () => setShortcutsOpen(true),
  };

  return (
    <div className="flex h-dvh flex-col text-xs">
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <DiffToolbar
        allCollapsed={allCollapsed}
        config={config}
        isLocal={usesLocalStore}
        baseRef={isBranch ? baseRef : undefined}
        onSettingsOpenChange={setSettingsOpen}
        onSidebarToggle={openSidebar}
        onSubmitPendingComments={submitPendingComments}
        onToggleAllCollapsed={toggleAllFilesCollapsed}
        onExport={handleExport}
        exporting={exporting}
        onMenuOpen={loadRepoContext}
        githubRepoUrl={githubRepoUrl}
        githubPrUrl={githubPrUrl}
        prDiffPath={prDiffPath}
        branchDiffPath={branchDiffPath}
        localDiffPath={localDiffPath}
        pendingCommentCount={pendingCommentThreads.length}
        pullRequestInfo={currentPullRequestInfo}
        prUrl={prUrl}
        settings={settingsProps}
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
        <div ref={codeViewAreaRef} className="flex min-w-0 flex-1">
          {initialItems.length === 0 ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconChecks />
                </EmptyMedia>
                <EmptyTitle>All files reviewed</EmptyTitle>
                <EmptyDescription>
                  Every changed file is marked as reviewed and hidden.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <button
                  type="button"
                  onClick={() => setHideReviewed(false)}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Show reviewed files
                </button>
              </EmptyContent>
            </Empty>
          ) : (
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
              renderHeaderMetadata={renderHeaderMetadata}
              renderCodeViewHeader={renderCodeViewHeader}
              renderCodeViewFooter={renderCodeViewFooter}
            />
          )}
        </div>
      </div>
    </div>
  );
}
