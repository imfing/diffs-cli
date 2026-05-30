import { useCallback, useEffect, useMemo, useState, useRef, lazy, Suspense } from "react";
import { useParams, useSearchParams, Link } from "react-router";
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
  resolveColorScheme,
  storedColorScheme,
  watchSystemColorScheme,
  type AppColorScheme,
} from "@/lib/colorScheme";
import { ChevronRight, Check, CircleAlert, ExternalLink, FileX2, CheckCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DiffAnnotation } from "./diff-view/DiffAnnotation";
import { DiffToolbar } from "./diff-view/DiffToolbar";
import { FileActionsMenu } from "./diff-view/FileActionsMenu";
import { SidebarTree } from "./diff-view/SidebarTree";
import type {
  AnnotationMeta,
  AppConfig,
  CodeViewLineSelection,
  CommentTarget,
  DiffOrderBy,
  DiffOrderDir,
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
import { apiFetch } from "@/lib/api";
import { exportDiffToHtml } from "@/lib/exportHtml";
import { DEFAULT_CODE_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, prependFontFamily } from "@/lib/fonts";

const MobileSidebarDrawer = lazy(() => import("./diff-view/MobileSidebarDrawer"));

const codeViewStyle = {
  flex: 1,
  overflow: "auto" as const,
  scrollbarGutter: "stable" as const,
};

const STORAGE_DIFF_THEME = "diff-theme";
const STORAGE_DIFF_STYLE = "diffs-diff-style";
const STORAGE_ORDER_BY = "diffs-order-by";
const STORAGE_ORDER_DIR = "diffs-order-dir";
const STORAGE_WORD_WRAP = "diffs-word-wrap";
const STORAGE_LINE_NUMBERS = "diffs-line-numbers";
const STORAGE_LINE_BACKGROUNDS = "diffs-line-backgrounds";
const STORAGE_COLLAPSE_REMOVALS = "diffs-collapse-removals";
const STORAGE_HIDE_REVIEWED = "diffs-hide-reviewed";

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

function readStoredOrderBy(): DiffOrderBy | null {
  const value = localStorage.getItem(STORAGE_ORDER_BY);
  return isDiffOrderBy(value) ? value : null;
}

function readStoredOrderDir(): DiffOrderDir | null {
  const value = localStorage.getItem(STORAGE_ORDER_DIR);
  return isDiffOrderDir(value) ? value : null;
}

function patchCacheKeyPrefix(patch: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < patch.length; i++) {
    h ^= patch.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function readCollapsedPaths(key: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function persistCollapsedPaths(key: string, paths: Set<string>) {
  sessionStorage.setItem(key, JSON.stringify([...paths]));
}

// Reviewed state maps a file path to the signature of the diff that was
// reviewed. A file counts as reviewed only while its current signature still
// matches the stored one, so any change to the file's diff auto-clears it.
function readReviewedSignatures(key: string): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return new Map(Object.entries(parsed as Record<string, string>));
    }
    return new Map();
  } catch {
    return new Map();
  }
}

function persistReviewedSignatures(key: string, signatures: Map<string, string>) {
  sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(signatures)));
}

// Stable signature of a file's diff. Folds the git blob object IDs (parsed from
// the patch `index` line) together with each hunk header; both change whenever
// the file's content on either side of the diff changes.
function fileDiffSignature(file: FileDiffMetadata): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  feed(file.prevObjectId ?? "");
  feed("..");
  feed(file.newObjectId ?? "");
  // Object IDs are absent/zeroed for working-tree diffs, so fold the actual
  // content lines too. For patch-parsed diffs these hold only the changed
  // lines, keeping this bounded to the size of the diff.
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
  return (h >>> 0).toString(36);
}

// Single source of truth for whether a file should render collapsed. A file
// collapses if the user manually collapsed it, it is reviewed, or the
// "collapse removals" setting applies to a deleted file. Every place that sets
// `collapsed` imperatively routes through here so the three independent reasons
// can't clobber one another (e.g. un-reviewing a deleted file must keep it
// collapsed while "collapse removals" is on).
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

export function DiffView({ source = "pr" }: { source?: "pr" | "local" | "branch" } = {}) {
  const { org, repo, number } = useParams<{
    org: string;
    repo: string;
    number: string;
  }>();
  const [searchParams] = useSearchParams();
  const baseRef = source === "branch" ? (searchParams.get("base") ?? "") : "";
  const includeDirty = source === "branch" && searchParams.get("dirty") === "1";

  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() => readStoredDiffStyle() ?? "split");
  const [orderBy, setOrderBy] = useState<DiffOrderBy>(() => readStoredOrderBy() ?? "path");
  const [orderDir, setOrderDir] = useState<DiffOrderDir>(() => readStoredOrderDir() ?? "asc");
  const [diffThemeId, setDiffThemeId] = useState<DiffThemeId>(
    () => readStoredDiffTheme() ?? "pierre",
  );
  const [appColorScheme, setAppColorScheme] = useState<AppColorScheme>(() => initialColorScheme());
  const [systemColorScheme, setSystemColorScheme] = useState(() => resolveColorScheme("system"));
  const [allCollapsedOverride, setAllCollapsed] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showBackground, setShowBackground] = useState(
    () => readStoredBool(STORAGE_LINE_BACKGROUNDS) ?? true,
  );
  const [showLineNumbers, setShowLineNumbers] = useState(
    () => readStoredBool(STORAGE_LINE_NUMBERS) ?? true,
  );
  const [wordWrap, setWordWrap] = useState(() => readStoredBool(STORAGE_WORD_WRAP) ?? false);
  const [collapseRemovals, setCollapseRemovals] = useState(
    () => readStoredBool(STORAGE_COLLAPSE_REMOVALS) ?? false,
  );
  const [hideReviewed, setHideReviewed] = useState(
    () => readStoredBool(STORAGE_HIDE_REVIEWED) ?? false,
  );
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
        if (
          typeof nextConfig.lineNumbers === "boolean" &&
          readStoredBool(STORAGE_LINE_NUMBERS) == null
        ) {
          setShowLineNumbers(nextConfig.lineNumbers);
        }
        if (
          typeof nextConfig.lineBackgrounds === "boolean" &&
          readStoredBool(STORAGE_LINE_BACKGROUNDS) == null
        ) {
          setShowBackground(nextConfig.lineBackgrounds);
        }
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);

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
  // Raw patch text per file, so the per-file menu can copy exactly what git
  // emitted for that file without reconstructing it from the parsed metadata.
  const filePatchSections = useMemo(
    () => splitPatchByFile(effectivePatchState.patch),
    [effectivePatchState.patch],
  );
  // Resolves GitHub/branch links once per session for the toolbar menu and the
  // local empty state. Triggered lazily — on menu open (below) or when the local
  // empty state shows — so a normal diff view never spawns the gh/git lookups.
  // Only local/branch sessions have a backing repo; PR mode derives its links
  // from the route instead.
  const loadRepoContext = useCallback(() => {
    if (!usesLocalStore || repoContextRequested.current) return;
    repoContextRequested.current = true;
    apiFetch<{ repoUrl?: string; prUrl?: string; branchBase?: string }>("/api/repo-context")
      .then(setRepoContext)
      .catch(() => {
        repoContextRequested.current = false;
      });
  }, [usesLocalStore]);
  // The local empty state's "View branch diff" CTA needs the resolved base, so
  // fetch when that state is reached even if the menu was never opened.
  const showLocalEmpty = isLocal && effectivePatchState.status === "loaded" && files.length === 0;
  useEffect(() => {
    if (showLocalEmpty) loadRepoContext();
  }, [showLocalEmpty, loadRepoContext]);
  // Reviewed signatures, reloaded synchronously whenever the storage key
  // changes (e.g. navigating between PRs) using the render-time reset pattern.
  const [reviewed, setReviewed] = useState<{ key: string; map: Map<string, string> }>(() => ({
    key: reviewedStorageKey,
    map: readReviewedSignatures(reviewedStorageKey),
  }));
  if (reviewed.key !== reviewedStorageKey) {
    setReviewed({ key: reviewedStorageKey, map: readReviewedSignatures(reviewedStorageKey) });
  }
  // Files whose current signature still matches a reviewed signature; only
  // populated while "Hide reviewed" is on so it stays empty (and cheap) otherwise.
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
  // Folding the hidden set into the key remounts CodeView when files are hidden
  // or revealed (it has no imperative removeItem); the scroll-restore effect
  // keyed on codeViewKey puts the user back where they were.
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
    // Build ids from the full file index so they stay stable regardless of which
    // files are hidden, then drop the hidden ones from the rendered list.
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
  // Maps each visible file to its CodeView item id. Ids keep the full-array
  // index so they match `initialItems`, but hidden (reviewed) files are omitted
  // so scroll/selection targets for them resolve to undefined and no-op instead
  // of leaving a stale selection pointing at an unmounted item.
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
  useEffect(() => {
    const area = codeViewAreaRef.current;
    if (!area) return;

    let timer = 0;
    const handleScroll = (e: Event) => {
      const el = e.target as HTMLElement;
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
    };
  }, [scrollStorageKey, codeViewKey]);
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
      // Mutate the map in place so the header re-render triggered below (which
      // still closes over the current `reviewed`) reads the updated value; the
      // new wrapper object from setReviewed drives subsequent re-renders.
      if (nextReviewed) map.set(name, sig);
      else map.delete(name);
      persistReviewedSignatures(reviewedStorageKey, map);
      setReviewed({ key: reviewedStorageKey, map });
      // Reviewing collapses the file; un-reviewing only expands it when no other
      // reason (manual collapse, collapse-removals) still applies.
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
  const handleColorSchemeChange = useCallback((value: AppColorScheme) => {
    setAppColorScheme(value);
    persistColorScheme(value);
  }, []);
  const handleDiffThemeChange = useCallback((id: DiffThemeId) => {
    setDiffThemeId(id);
    localStorage.setItem(STORAGE_DIFF_THEME, id);
  }, []);
  const handleDiffStyleToggle = useCallback(() => {
    setDiffStyle((prev) => {
      const next: DiffStyle = prev === "split" ? "unified" : "split";
      localStorage.setItem(STORAGE_DIFF_STYLE, next);
      return next;
    });
  }, []);
  const handleOrderByChange = useCallback((value: DiffOrderBy) => {
    setOrderBy(value);
    localStorage.setItem(STORAGE_ORDER_BY, value);
  }, []);
  const handleOrderDirToggle = useCallback(() => {
    setOrderDir((prev) => {
      const next: DiffOrderDir = prev === "asc" ? "desc" : "asc";
      localStorage.setItem(STORAGE_ORDER_DIR, next);
      return next;
    });
  }, []);
  const handleWordWrapChange = useCallback((value: boolean) => {
    setWordWrap(value);
    localStorage.setItem(STORAGE_WORD_WRAP, String(value));
  }, []);
  const handleShowLineNumbersChange = useCallback((value: boolean) => {
    setShowLineNumbers(value);
    localStorage.setItem(STORAGE_LINE_NUMBERS, String(value));
  }, []);
  const handleShowBackgroundChange = useCallback((value: boolean) => {
    setShowBackground(value);
    localStorage.setItem(STORAGE_LINE_BACKGROUNDS, String(value));
  }, []);
  const handleCollapseRemovalsChange = useCallback(
    (value: boolean) => {
      setCollapseRemovals(value);
      localStorage.setItem(STORAGE_COLLAPSE_REMOVALS, String(value));
      const viewer = viewerRef.current;
      if (!viewer) return;
      // Apply immediately to every deleted file already in the view, but defer to
      // the other collapse reasons so a reviewed deleted file stays collapsed.
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
    [initialItems, collapsedStorageKey, reviewed, fileSignatures],
  );
  const handleHideReviewedChange = useCallback((value: boolean) => {
    setHideReviewed(value);
    localStorage.setItem(STORAGE_HIDE_REVIEWED, String(value));
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
      onGutterUtilityClick: openCommentTarget,
      onLineSelectionEnd: openCommentTarget,
      layout: { paddingTop: 12, paddingBottom: 12, gap: 12 },
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

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      if (item.type !== "diff" || !item.fileDiff) return null;
      const sig = fileSignatures.get(item.fileDiff.name);
      const isReviewed = sig != null && reviewed.map.get(item.fileDiff.name) === sig;
      return (
        <div className="flex items-center gap-1">
          <label
            title="Mark file as reviewed (collapses it)"
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
              {isReviewed && <Check size={12} strokeWidth={3} />}
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

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">Loading diff...</div>
    );
  }

  if (error) {
    return (
      <div className="flex h-dvh flex-col">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlert />
            </EmptyMedia>
            <EmptyTitle>Failed to load diff</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Back
            </Link>
          </EmptyContent>
        </Empty>
      </div>
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
      <div className="flex h-dvh flex-col">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileX2 />
            </EmptyMedia>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription>{emptyMessage}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
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
                <ExternalLink />
                Open in browser
              </a>
            ) : (
              <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Back
              </Link>
            )}
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  // Context-aware links for the toolbar menu, shown only when resolvable. In PR
  // mode the repo URL comes straight from the route; otherwise from the lazily
  // fetched repo context. "View PR diff" navigates in-app, the others open
  // GitHub; both are omitted for the mode that's already showing that diff.
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
  // The counterpart to "View branch diff": branch mode offers a jump to the
  // working-tree diff that `diffs` shows by default.
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
        isLocal={usesLocalStore}
        baseRef={isBranch ? baseRef : undefined}
        onColorSchemeChange={handleColorSchemeChange}
        onDiffStyleToggle={handleDiffStyleToggle}
        orderBy={orderBy}
        orderDir={orderDir}
        onOrderByChange={handleOrderByChange}
        onOrderDirToggle={handleOrderDirToggle}
        onDiffThemeChange={handleDiffThemeChange}
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
        wordWrap={wordWrap}
        collapseRemovals={collapseRemovals}
        hideReviewed={hideReviewed}
        prUrl={prUrl}
        selectedDiffThemeLabel={selectedDiffTheme.label}
        setShowBackground={handleShowBackgroundChange}
        setShowLineNumbers={handleShowLineNumbersChange}
        setWordWrap={handleWordWrapChange}
        setCollapseRemovals={handleCollapseRemovalsChange}
        setHideReviewed={handleHideReviewedChange}
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
                  <CheckCheck />
                </EmptyMedia>
                <EmptyTitle>All files reviewed</EmptyTitle>
                <EmptyDescription>
                  Every changed file is marked as reviewed and hidden.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <button
                  type="button"
                  onClick={() => handleHideReviewedChange(false)}
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
            />
          )}
        </div>
      </div>
    </div>
  );
}
