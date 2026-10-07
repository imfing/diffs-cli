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
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useParams, useSearchParams, useLocation, Link } from "react-router";
import {
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewScrollBehavior,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItemEditCompleteHandler,
  EditProvider,
  useWorkerPool,
} from "@pierre/diffs/react";
import { Editor, type EditorFactory, type FileDiffEditCompleteEvent } from "@pierre/diffs/edit";
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
import { Button, buttonVariants } from "@/components/ui/button";
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
import { DiffToolbar, type ToolbarLink } from "./diff-view/DiffToolbar";
import { FileActionsMenu } from "./diff-view/FileActionsMenu";
import { ShortcutsDialog } from "./diff-view/ShortcutsDialog";
import { SidebarTree } from "./diff-view/SidebarTree";
import { GuideStepPanel } from "./guide/GuideStepPanel";
import {
  orderFilesByGuide,
  type Guide,
  type GuideDisplayStep,
  type GuideSummary,
} from "./guide/guideModel";
import type {
  AnnotationMeta,
  AppConfig,
  CodeViewLineSelection,
  CommentTarget,
  PendingCommentDraft,
  PatchLoadState,
  PullRequestInfo,
  ReviewThread,
} from "./diff-view/types";
import {
  diffThemeOptions,
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
import { useSettings, type SetSetting } from "./diff-view/useSettings";
import { apiFetch, apiSend } from "@/lib/api";
import { DIFF_SURFACE_FONT_SIZE } from "@/lib/diffTypography";
import { exportDiffToHtml } from "@/lib/exportHtml";
import { DEFAULT_CODE_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, prependFontFamily } from "@/lib/fonts";

const MobileSidebarDrawer = lazy(() => import("./diff-view/MobileSidebarDrawer"));

const SIDEBAR_WIDTH_KEY = "diffs-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 320;

const codeViewStyle = {
  flex: 1,
  overflow: "auto" as const,
  scrollbarGutter: "stable" as const,
  "--diffs-font-size": DIFF_SURFACE_FONT_SIZE,
} as CSSProperties;

// Stable empty-steps reference so non-guide renders don't churn a new array.
const EMPTY_STEPS: GuideDisplayStep[] = [];

// Window after a programmatic scroll during which the cursor isn't re-synced.
const PROGRAMMATIC_SCROLL_SETTLE_MS = 250;
// Guide step advances once the next step's first file crosses this fraction of
// the viewport height (measured from the top), so the panel leads the cursor.
const STEP_PROBE_FRACTION = 0.5;
const EDITABLE_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

type Viewer = CodeViewHandle<AnnotationMeta, undefined>;
type Item = CodeViewItem<AnnotationMeta>;

// updateItem ignores same-version updates, so every change bumps the version.
function patchItem(viewer: Viewer, item: Item, patch: Partial<Item>) {
  viewer.updateItem({ ...item, ...patch, version: (item.version ?? 0) + 1 } as Item);
}

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

// Local/branch diffs use an all-zeros object id for the working-tree side
// (git diffs against the workdir, not a blob), so that side has to be read
// from disk instead of the object database.
function isZeroOid(oid: string | undefined): boolean {
  return !oid || /^0+$/.test(oid);
}

// Full-file hydration for `loadDiffFiles`. Blobs are keyed for highlight cache
// reuse; PR files go through the fork-aware server proxy (gh::pull_request_file).
async function fetchFile(url: string, name: string, cacheKey?: string): Promise<FileContents> {
  return { name, contents: await apiFetch<string>(url), cacheKey };
}
const fetchBlob = (oid: string, name: string) =>
  fetchFile(`/api/blob?oid=${encodeURIComponent(oid)}`, name, `blob:${oid}`);
const fetchWorktree = (path: string) =>
  fetchFile(`/api/blob?${new URLSearchParams({ path, worktree: "1" })}`, path);
const fetchRevFile = (rev: string, path: string) =>
  fetchFile(`/api/blob?${new URLSearchParams({ path, rev })}`, path);

export function DiffView({ source = "pr" }: { source?: "pr" | "local" | "branch" } = {}) {
  const { org, repo, number } = useParams<{
    org: string;
    repo: string;
    number: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const baseRef = source === "branch" ? (searchParams.get("base") ?? "") : "";
  // Explicit branch to review; empty means the checked-out branch.
  const headRef = source === "branch" ? (searchParams.get("head") ?? "") : "";
  const includeDirty = source === "branch" && searchParams.get("dirty") === "1";
  const guideParam = searchParams.get("guide") ?? "";
  // The /guide/:slug redirect hands the already-fetched guide down via router
  // state; reuse it for the matching slug to skip an immediate refetch.
  const navGuide = (location.state as { guide?: Guide } | null)?.guide ?? null;

  const [appColorScheme, setAppColorScheme] = useState<AppColorScheme>(() => initialColorScheme());
  const [systemColorScheme, setSystemColorScheme] = useState(() => resolveColorScheme("system"));
  const [allCollapsedOverride, setAllCollapsed] = useState<boolean | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || DEFAULT_SIDEBAR_WIDTH,
  );
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);
  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const left = handle.parentElement!.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    const onMove = (e: PointerEvent) =>
      setSidebarWidth(Math.round(Math.min(Math.max(e.clientX - left, 200), 640)));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }, []);
  const [submittingPendingComments, setSubmittingPendingComments] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [repoContext, setRepoContext] = useState<{
    repoUrl?: string;
    prUrl?: string;
    branchBase?: string;
  } | null>(null);
  const repoContextRequested = useRef(false);
  const viewerRef = useRef<Viewer | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  // Ref copy for callbacks that shouldn't re-subscribe.
  const editingItemIdRef = useRef<string | null>(null);
  // Save/Cancel choice, read by handleItemEditComplete.
  const editDecisionRef = useRef<"accept" | "reject">("reject");
  const pendingDiffReloadRef = useRef(false);
  const reloadDiffRef = useRef<(() => void) | null>(null);
  const codeViewAreaRef = useRef<HTMLDivElement>(null);
  const currentFileRef = useRef<string | null>(null);
  const programmaticScrollAtRef = useRef(0);
  // Latest path→step map, read inside the scroll handler without re-subscribing.
  const fileToStepRef = useRef<Map<string, number> | null>(null);
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
  const [settings, setSetting] = useSettings(config);
  const {
    diffStyle,
    orderBy,
    orderDir,
    diffTheme,
    lineBackgrounds,
    lineNumbers,
    wordWrap,
    collapseRemovals,
    hideReviewed,
  } = settings;
  // Guide mode: guides available for this diff's branch, the active guide's
  // fetched detail, and the step currently in view. The active slug lives in
  // the `guide` query param alone (null = off), so toggle, shared links, and
  // browser history all stay in sync.
  const [availableGuides, setAvailableGuides] = useState<GuideSummary[]>([]);
  const activeGuideSlug = guideParam || null;
  const [activeGuide, setActiveGuide] = useState<Guide | null>(
    navGuide && navGuide.slug === guideParam ? navGuide : null,
  );
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  // A newly active guide always starts at step 1, however it became active
  // (toggle, link, back/forward) and even when its detail is already cached.
  // Reset during render rather than in an effect to avoid a stale-step frame.
  const [stepGuideSlug, setStepGuideSlug] = useState(activeGuideSlug);
  if (stepGuideSlug !== activeGuideSlug) {
    setStepGuideSlug(activeGuideSlug);
    setCurrentStepIndex(0);
  }

  const isLocal = source === "local";
  const isBranch = source === "branch";
  const usesLocalStore = isLocal || isBranch;
  const sessionKey = isLocal
    ? "local"
    : isBranch
      ? `branch:${baseRef}${headRef ? `...${headRef}` : ""}`
      : `pr:${org}/${repo}/${number}`;
  const scrollStorageKey = `diffs-scroll:${sessionKey}`;
  const collapsedStorageKey = `diffs-collapsed:${sessionKey}`;
  const reviewedStorageKey = `diffs-reviewed:${sessionKey}`;
  const hasPr = !usesLocalStore && !!org && !!repo && !!number;
  const prUrl =
    org && repo && number ? `https://${config.githubHost}/${org}/${repo}/pull/${number}` : "";
  const prQuery = hasPr ? new URLSearchParams({ org, repo, number }).toString() : "";
  // Local threads and guides are scoped to the reviewed branch, not the checked-out one.
  const localBranchQuery = headRef ? `?branch=${encodeURIComponent(headRef)}` : "";
  const commentsEndpoint = usesLocalStore
    ? `/api/comments${localBranchQuery}`
    : hasPr
      ? `/api/comments?${prQuery}`
      : null;
  const pullRequestInfoEndpoint = hasPr
    ? `/api/pull/${[org, repo, number].map(encodeURIComponent).join("/")}`
    : null;
  const headLabel = headRef || config.gitBranch.trim();
  const baseTitle = isBranch
    ? `${baseRef || "base"} ← ${headLabel || "HEAD"}`
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
      // Reloading remounts CodeView and would kill the edit; defer it.
      if (editingItemIdRef.current != null) {
        pendingDiffReloadRef.current = true;
        return;
      }
      const endpoint = isBranch
        ? `/api/branch-diff?${new URLSearchParams({
            base: baseRef,
            ...(headRef ? { head: headRef } : {}),
            ...(includeDirty ? { dirty: "1" } : {}),
          })}`
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
    reloadDiffRef.current = load;
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
  }, [isLocal, isBranch, usesLocalStore, baseRef, headRef, includeDirty, org, repo, number]);

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

  // Guides are scoped to the reviewed branch (like local comments); PR mode has none.
  useEffect(() => {
    if (!usesLocalStore) return;
    let ignore = false;
    apiFetch<{ guides?: GuideSummary[] }>(`/api/guides${localBranchQuery}`)
      .then((data) => {
        if (!ignore) setAvailableGuides(data.guides ?? []);
      })
      .catch(() => {
        if (!ignore) setAvailableGuides([]);
      });
    return () => {
      ignore = true;
    };
  }, [usesLocalStore, localBranchQuery]);

  // The active guide's full detail (steps + files), fetched when the slug
  // changes unless it's already in hand (seeded from the redirect's router
  // state, or cached from a prior open).
  useEffect(() => {
    if (!activeGuideSlug) return;
    if (activeGuide?.slug === activeGuideSlug) return;
    let ignore = false;
    apiFetch<Guide>(`/api/guides/${encodeURIComponent(activeGuideSlug)}`)
      .then((guide) => {
        if (!ignore) setActiveGuide(guide);
      })
      .catch(() => {
        if (!ignore) setActiveGuide(null);
      });
    return () => {
      ignore = true;
    };
  }, [activeGuideSlug, activeGuide]);

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

  const patch = effectivePatchState.status === "loaded" ? effectivePatchState.patch : null;
  const parsedFiles = useMemo(
    () => (patch ? parsePatchFiles(patch, patchCacheKeyPrefix(patch)).flatMap((p) => p.files) : []),
    [patch],
  );
  // The fetched guide only counts once it matches the requested slug, so a stale
  // guide never lingers across a switch or after the toggle is turned off.
  const loadedGuide =
    activeGuide != null && activeGuide.slug === activeGuideSlug ? activeGuide : null;
  const guideMode = usesLocalStore && loadedGuide != null;
  const guideOrdering = useMemo(
    () => (guideMode && loadedGuide ? orderFilesByGuide(parsedFiles, loadedGuide.steps) : null),
    [guideMode, loadedGuide, parsedFiles],
  );
  // Mirror the path→step map into a ref the scroll handler can read without
  // re-subscribing.
  useEffect(() => {
    fileToStepRef.current = guideOrdering?.fileToStep ?? null;
  }, [guideOrdering]);
  // Guide mode imposes step order; otherwise the user's chosen sort applies.
  const files = useMemo<FileDiffMetadata[]>(
    () => (guideOrdering ? guideOrdering.files : sortFiles(parsedFiles, orderBy, orderDir)),
    [guideOrdering, parsedFiles, orderBy, orderDir],
  );
  const fileSignatures = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of files) if (!map.has(f.name)) map.set(f.name, fileDiffSignature(f));
    return map;
  }, [files]);
  const filePatchSections = useMemo(
    () => splitPatchByFile(patch, parsedFiles),
    [patch, parsedFiles],
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
  const reviewedNames = useMemo(() => {
    const names = new Set<string>();
    for (const f of files) {
      const sig = fileSignatures.get(f.name);
      if (sig != null && reviewed.map.get(f.name) === sig) names.add(f.name);
    }
    return names;
  }, [files, fileSignatures, reviewed]);
  const hiddenReviewedNames = useMemo(
    () => (hideReviewed ? reviewedNames : new Set<string>()),
    [hideReviewed, reviewedNames],
  );
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
  const codeViewKey = `${effectivePatchState.patch ?? "empty"}:${orderBy}:${orderDir}:${hiddenReviewedKey}:${guideMode ? activeGuideSlug : ""}`;
  const pendingCommentThreads = useMemo(
    () => commentThreads.filter((thread) => thread.pending && thread.draft),
    [commentThreads],
  );
  const currentPullRequestInfo =
    pullRequestInfo?.endpoint === pullRequestInfoEndpoint ? pullRequestInfo.info : null;

  const filePaths = useMemo(() => [...new Set(visibleFiles.map((f) => f.name))], [visibleFiles]);
  const initialItems = useMemo<Item[]>(() => {
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
    () => diffThemeOptions.find((option) => option.id === diffTheme) ?? diffThemeOptions[0],
    [diffTheme],
  );
  const resolvedAppColorScheme = appColorScheme === "system" ? systemColorScheme : appColorScheme;
  const workerPool = useWorkerPool();
  useEffect(() => {
    void workerPool?.setRenderOptions({ theme: selectedDiffTheme.theme });
  }, [workerPool, selectedDiffTheme.theme]);
  const allCollapsed =
    allCollapsedOverride ??
    (initialItems.length > 0 && initialItems.every((item) => item.collapsed));
  // The last file whose header has scrolled to within `probePx` of the viewport
  // top, via the data-diff-file markers from renderHeaderMetadata. The marker is
  // slotted into the header's vertically centered metadata row, so its own top
  // is ~half a header below where the header sticks; measuring the marker would
  // lag detection by one file. Reach the actual sticky header — the marker's
  // slot wrapper is assigned into the header's shadow DOM — so a header reads at
  // its true position (top === areaTop the instant it sticks), with a fallback
  // to the marker's own rect if the structure ever changes.
  const fileAtViewportOffset = useCallback((probePx: number): string | null => {
    const area = codeViewAreaRef.current;
    if (!area) return null;
    const markers = area.querySelectorAll<HTMLElement>("[data-diff-file]");
    if (markers.length === 0) return null;
    const areaTop = area.getBoundingClientRect().top;
    const headerOffset = (marker: HTMLElement): number => {
      const slot = marker.closest<HTMLElement>("[slot]")?.assignedSlot;
      const header = slot?.closest<HTMLElement>("[data-diffs-header]") ?? marker;
      return header.getBoundingClientRect().top - areaTop;
    };
    let current = markers[0].getAttribute("data-diff-file");
    for (let i = 1; i < markers.length; i++) {
      if (headerOffset(markers[i]) > probePx) break;
      current = markers[i].getAttribute("data-diff-file");
    }
    return current;
  }, []);
  // The file whose sticky header sits at the very top — the keyboard cursor for
  // n/p/m navigation.
  const getCurrentFile = useCallback(() => fileAtViewportOffset(8), [fileAtViewportOffset]);
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
          const cf = getCurrentFile() ?? currentFileRef.current;
          currentFileRef.current = cf;
          // In guide mode, advance the step as soon as the next step's first
          // file crosses the viewport's vertical midpoint, rather than waiting
          // for it to reach the top — the step changes ahead of the cursor.
          const map = fileToStepRef.current;
          if (map) {
            const stepFile = fileAtViewportOffset(el.clientHeight * STEP_PROBE_FRACTION) ?? cf;
            const step = stepFile != null ? map.get(stepFile) : undefined;
            if (step != null) setCurrentStepIndex((prev) => (prev === step ? prev : step));
          }
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
  }, [scrollStorageKey, codeViewKey, getCurrentFile, fileAtViewportOffset]);
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
  // Selecting a step's file pill jumps straight to it. Set the owning step
  // up front so the panel switches immediately, and scroll instantly: a
  // smooth scroll outlasts the programmatic-settle window, letting a mid-flight
  // scroll event resync the step to whatever file is still passing the top
  // (the previous step's file), which would snap the panel back a step.
  const selectGuideFile = useCallback(
    (path: string) => {
      const step = fileToStepRef.current?.get(path);
      if (step != null) setCurrentStepIndex(step);
      scrollToFile(path, "instant");
    },
    [scrollToFile],
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
  // Toggling guide mode (re)opens the latest guide or turns it off by writing
  // the `guide` query param, the single source of truth for the active slug.
  // TODO: when a branch has several guides, let the user pick instead of
  // defaulting to latest.
  const toggleGuide = useCallback(() => {
    const next = activeGuideSlug ? null : (availableGuides[0]?.slug ?? null);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next) params.set("guide", next);
        else params.delete("guide");
        return params;
      },
      { replace: true },
    );
  }, [activeGuideSlug, availableGuides, setSearchParams]);
  const toggleFileCollapsed = useCallback(
    (itemId: string) => {
      const viewer = viewerRef.current;
      const item = viewer?.getItem(itemId);
      if (item == null) return;
      const nextCollapsed = !item.collapsed;
      patchItem(viewer!, item, { collapsed: nextCollapsed });
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
        patchItem(viewer, current, { collapsed: next });
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
      patchItem(viewer!, item, {
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
    // The editor lives in shadow DOM, so the target check below misses it.
    if (editingItemIdRef.current != null) return;
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
  const handleSettingChange = useCallback<SetSetting>(
    (name, value) => {
      setSetting(name, value);
      if (name !== "collapseRemovals") return;
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
          value as boolean,
        );
        if (current.collapsed !== next) patchItem(viewer, current, { collapsed: next });
      }
    },
    [initialItems, collapsedStorageKey, reviewed, fileSignatures, setSetting],
  );

  const clearCommentTarget = useCallback(() => {
    setCommentTarget(null);
    setSelectedLines(null);
  }, []);

  const openCommentTarget = useCallback(
    (range: SelectedLineRange | null, context: { item: Item }) => {
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
      const { path, line, side, endLine, endSide } = commentTarget;
      apiSend<ReviewThread>(commentsEndpoint, "POST", { path, line, side, endLine, endSide, body })
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
        const submittedThread = await apiSend<ReviewThread>(commentsEndpoint, "POST", draft);
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
      apiFetch(`/api/comments/${encodeURIComponent(thread.id)}${localBranchQuery}`, {
        method: "DELETE",
      })
        .then(() => {
          setCommentThreads((prev) => prev.filter((current) => current.id !== thread.id));
        })
        .catch((err) => {
          console.error("Failed to delete comment:", err);
        });
    },
    [usesLocalStore, localBranchQuery],
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

      patchItem(viewer, current, {
        annotations: annotations.length > 0 ? annotations : undefined,
      });
    }
  }, [commentThreads, commentTarget, initialItems, filePathToItemId]);

  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const oldName = fileDiff.prevName ?? fileDiff.name;
      const newName = fileDiff.name;
      if (!usesLocalStore) {
        if (!hasPr) throw new Error("missing pull request target");
        const prFile = (path: string, side: "old" | "new") =>
          fetchFile(`${pullRequestInfoEndpoint}/file?${new URLSearchParams({ path, side })}`, path);
        if (fileDiff.type === "rename-pure")
          return { oldFile: null, newFile: await prFile(newName, "new") };
        const [oldFile, newFile] = await Promise.all([
          prFile(oldName, "old"),
          prFile(newName, "new"),
        ]);
        return { oldFile, newFile };
      }
      // Pure renames carry no `index` line (and thus no object ids); their
      // content is unchanged, so read the new path from the worktree, or from
      // the reviewed branch when it isn't the checked-out one.
      if (fileDiff.type === "rename-pure")
        return {
          oldFile: null,
          newFile: await (headRef ? fetchRevFile(headRef, newName) : fetchWorktree(newName)),
        };
      const { prevObjectId, newObjectId } = fileDiff;
      if (isZeroOid(prevObjectId)) throw new Error(`missing prevObjectId for ${fileDiff.name}`);
      const [oldFile, newFile] = await Promise.all([
        fetchBlob(prevObjectId!, oldName),
        // Local worktree oids usually aren't in the object db; read the file.
        (isLocal && fileDiff.type !== "deleted") || isZeroOid(newObjectId)
          ? fetchWorktree(newName)
          : fetchBlob(newObjectId!, newName),
      ]);
      return { oldFile, newFile };
    },
    [usesLocalStore, isLocal, hasPr, pullRequestInfoEndpoint, headRef],
  );

  // Only local diffs edit the worktree. Pure renames have no rows to edit.
  const canEditFile = useCallback(
    (fileDiff: FileDiffMetadata): boolean =>
      isLocal && fileDiff.type !== "deleted" && fileDiff.type !== "rename-pure",
    [isLocal],
  );

  const startEditingFile = useCallback((itemId: string) => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (!viewer || !item) return;
    editDecisionRef.current = "reject";
    editingItemIdRef.current = itemId;
    setEditingItemId(itemId);
    // Pierre won't hydrate new files, so they'd stay partial and uneditable.
    // Their patch has every line, so mark them complete; a new cacheKey makes
    // Pierre pick up the copy.
    const fileDiff =
      item.type === "diff" && item.fileDiff.type === "new" && item.fileDiff.isPartial
        ? {
            ...item.fileDiff,
            isPartial: false,
            cacheKey: `${item.fileDiff.cacheKey ?? item.id}:complete`,
          }
        : undefined;
    patchItem(viewer, item, { ...(fileDiff ? { fileDiff } : {}), edit: true });
  }, []);

  const finishEditingFile = useCallback((itemId: string, decision: "accept" | "reject") => {
    editDecisionRef.current = decision;
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (viewer && item) {
      // Ends the session; handleItemEditComplete applies the decision.
      patchItem(viewer, item, { edit: false });
    } else {
      editingItemIdRef.current = null;
      setEditingItemId(null);
    }
  }, []);

  const saveWorktreeFile = useCallback(async (path: string, contents: string) => {
    try {
      await apiSend("/api/worktree-file", "PUT", { path, contents });
    } catch (err) {
      console.error(`Failed to save ${path}:`, err);
      // Disk still has the old content; re-sync the view.
      reloadDiffRef.current?.();
    }
  }, []);

  const handleItemEditComplete = useCallback<
    CodeViewItemEditCompleteHandler<AnnotationMeta, undefined>
  >(
    (event, item) => {
      if (editingItemIdRef.current === item.id) {
        editingItemIdRef.current = null;
        setEditingItemId(null);
      }
      const decision = editDecisionRef.current;
      editDecisionRef.current = "reject";
      const hadPendingReload = pendingDiffReloadRef.current;
      pendingDiffReloadRef.current = false;
      // Saving triggers a reload itself; only reject needs an explicit one.
      const reject = () => {
        if (hadPendingReload) reloadDiffRef.current?.();
        return "reject" as const;
      };
      if (decision !== "accept" || item.type !== "diff") return reject();
      const completed = event as FileDiffEditCompleteEvent<AnnotationMeta, undefined>;
      if (!completed.newFile) return reject();
      // New cacheKey so the render cache doesn't serve the old diff.
      completed.fileDiff.cacheKey = `edited:${item.id}:${Date.now()}`;
      void saveWorktreeFile(completed.fileDiff.name, completed.newFile.contents);
      return "accept";
    },
    [saveWorktreeFile],
  );

  const createEditor = useCallback<EditorFactory<AnnotationMeta, undefined>>(
    (editorType, options, editStateKey) => new Editor(editorType, options, editStateKey),
    [],
  );

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
      disableBackground: !lineBackgrounds,
      disableLineNumbers: !lineNumbers,
      overflow: (wordWrap ? "wrap" : "scroll") as "wrap" | "scroll",
      enableGutterUtility: true,
      enableLineSelection: true,
      // Removes gutter "+" button's negative margin (overhangs line, blocks selection); shadow DOM needs unsafeCSS.
      unsafeCSS: "[data-utility-button] { margin-right: 0; }",
      onGutterUtilityClick: openCommentTarget,
      onLineSelectionEnd: openCommentTarget,
      loadDiffFiles,
      layout: { paddingTop: 0, paddingBottom: 12, gap: 12 },
    }),
    [
      selectedDiffTheme.theme,
      selectedDiffTheme.themeType,
      resolvedAppColorScheme,
      diffStyle,
      lineBackgrounds,
      lineNumbers,
      wordWrap,
      openCommentTarget,
      loadDiffFiles,
    ],
  );

  const handleExport = useCallback(async () => {
    if (exporting || visibleFiles.length === 0) return;
    setExporting(true);
    try {
      const subtitle = isLocal ? config.cwd : isBranch ? headLabel : prUrl;
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
    headLabel,
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
    (item: Item) => {
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
    (item: Item) => {
      if (item.type !== "diff" || !item.fileDiff) return null;
      if (editingItemId === item.id) {
        return (
          <div
            className="flex items-center gap-1.5"
            data-diff-file={item.fileDiff.name}
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => finishEditingFile(item.id, "reject")}
            >
              Cancel
            </Button>
            <Button type="button" size="xs" onClick={() => finishEditingFile(item.id, "accept")}>
              Save
            </Button>
          </div>
        );
      }
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
            onEdit={
              editingItemId == null && canEditFile(item.fileDiff)
                ? () => startEditingFile(item.id)
                : undefined
            }
          />
        </div>
      );
    },
    [
      fileSignatures,
      reviewed,
      toggleReviewed,
      filePatchSections,
      editingItemId,
      canEditFile,
      startEditingFile,
      finishEditingFile,
    ],
  );

  const branchDiffPath =
    isLocal && repoContext?.branchBase
      ? `/branch?base=${encodeURIComponent(repoContext.branchBase)}`
      : undefined;

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
    const [emptyTitle, emptyMessage] = isBranch
      ? ["No commits ahead", `No commits ahead of ${baseRef || "base"}.`]
      : isLocal
        ? ["No file changes yet", "The latest diffs are no longer available."]
        : ["No files changed", "This pull request doesn't change any files."];
    return (
      <DiffStatusScreen icon={<IconFileX />} title={emptyTitle} description={emptyMessage}>
        {branchDiffPath ? (
          <Link to={branchDiffPath} className={buttonVariants({ size: "sm" })}>
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

  const menuLinks: ToolbarLink[] = [
    [branchDiffPath, "branch"],
    [isBranch ? "/local" : undefined, "local"],
    [usesLocalStore && repoContext?.prUrl ? prDiffPathFromUrl(repoContext.prUrl) : undefined, "pr"],
    [usesLocalStore ? repoContext?.prUrl : prUrl, "github-pr"],
    [
      !usesLocalStore && org && repo
        ? `https://${config.githubHost}/${org}/${repo}`
        : repoContext?.repoUrl,
      "github-repo",
    ],
  ];

  const sidebarTreeProps = {
    paths: filePaths,
    files: visibleFiles,
    reviewedPaths: reviewedNames,
    comments: commentThreads,
    onFileActivate: scrollToFile,
    onCommentActivate: scrollToThread,
    onDeleteComment: deleteComment,
    colorScheme: resolvedAppColorScheme,
  };

  // Guide-mode derived values for the sidebar and toolbar toggle.
  const guideAvailable = usesLocalStore && (availableGuides.length > 0 || loadedGuide != null);
  const displaySteps = guideOrdering?.displaySteps ?? EMPTY_STEPS;
  const safeStepIndex =
    displaySteps.length === 0 ? 0 : Math.min(currentStepIndex, displaySteps.length - 1);
  const guidePanel = guideMode ? (
    <GuideStepPanel steps={displaySteps} current={safeStepIndex} onSelectFile={selectGuideFile} />
  ) : null;

  return (
    <div className="flex h-dvh flex-col text-xs">
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <DiffToolbar
        allCollapsed={allCollapsed}
        config={config}
        isLocal={usesLocalStore}
        baseRef={isBranch ? baseRef : undefined}
        headRef={isBranch ? headRef : undefined}
        includeDirty={isBranch ? includeDirty : false}
        onSidebarToggle={openSidebar}
        guideAvailable={guideAvailable}
        guideMode={guideMode}
        onToggleGuide={toggleGuide}
        onSubmitPendingComments={submitPendingComments}
        onToggleAllCollapsed={toggleAllFilesCollapsed}
        onExport={handleExport}
        exporting={exporting}
        onMenuOpen={loadRepoContext}
        links={menuLinks}
        pendingCommentCount={pendingCommentThreads.length}
        pullRequestInfo={currentPullRequestInfo}
        prUrl={prUrl}
        settings={{
          settings,
          onSettingChange: handleSettingChange,
          appColorScheme,
          onColorSchemeChange: handleColorSchemeChange,
          onShortcutsOpen: () => setShortcutsOpen(true),
        }}
        sidebarOpen={sidebarOpen}
        submittingPendingComments={submittingPendingComments}
      />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside
            className="relative hidden shrink-0 overflow-hidden border-r border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 md:block"
            style={{ width: sidebarWidth }}
          >
            {guidePanel ?? <SidebarTree {...sidebarTreeProps} />}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-neutral-300 dark:hover:bg-neutral-600"
              onPointerDown={startSidebarResize}
              onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
            />
          </aside>
        )}
        {mobileSidebarOpen && (
          <Suspense fallback={null}>
            <MobileSidebarDrawer open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
              {guidePanel ?? (
                <SidebarTree {...sidebarTreeProps} onClose={() => setMobileSidebarOpen(false)} />
              )}
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
                  onClick={() => setSetting("hideReviewed", false)}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Show reviewed files
                </button>
              </EmptyContent>
            </Empty>
          ) : (
            <EditProvider createEditor={createEditor}>
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
                onItemEditComplete={handleItemEditComplete}
              />
            </EditProvider>
          )}
        </div>
      </div>
    </div>
  );
}
