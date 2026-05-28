import { lazy, Suspense } from "react";
import {
  ArrowLeft,
  ExternalLink,
  PanelLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  GitBranch,
  GitPullRequest,
  SendHorizontal,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AppColorScheme } from "@/lib/colorScheme";
import type {
  AppConfig,
  DiffOrderBy,
  DiffOrderDir,
  DiffStyle,
  DiffThemeId,
  PullRequestInfo,
} from "./types";
import { displayLocalPath, headerIconButtonClass } from "./helpers";

const DiffSettingsPopover = lazy(() =>
  import("./DiffSettingsPopover").then((m) => ({ default: m.DiffSettingsPopover })),
);
const headerIconLinkClass = buttonVariants({
  variant: "ghost",
  size: "icon-sm",
  className: `${headerIconButtonClass} no-underline`,
});

function pullRequestTitle(prUrl: string) {
  try {
    const url = new URL(prUrl);
    const [owner, repo, kind, number] = url.pathname.split("/").filter(Boolean);
    if (owner && repo && kind === "pull" && number) {
      return { repo: `${owner}/${repo}`, pullRequest: `#${number}` };
    }
  } catch {
    // Fall through to the readable fallback below.
  }
  return { repo: prUrl, pullRequest: "" };
}

function pullRequestBranchLabel(info: PullRequestInfo, side: "base" | "head") {
  const label = side === "base" ? info.baseLabel : info.headLabel;
  const ref = side === "base" ? info.baseRef : info.headRef;
  const repo = side === "base" ? info.baseRepo : info.headRepo;
  if (label.trim() !== "") return label.trim();
  if (repo.trim() !== "" && ref.trim() !== "") return `${repo.trim()}:${ref.trim()}`;
  return ref.trim();
}

function pullRequestStatus(info: PullRequestInfo) {
  if (info.merged) return "Merged";
  if (info.state.toLowerCase() === "closed") return "Closed";
  if (info.draft) return "Draft";
  return "Open";
}

function pullRequestStatusClass(info: PullRequestInfo) {
  const status = pullRequestStatus(info);
  if (status === "Open") return "bg-[#1f883d] text-white";
  if (status === "Merged") return "bg-[#8250df] text-white";
  if (status === "Draft")
    return "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200";
  return "bg-[#cf222e] text-white";
}

function formatPullRequestDate(value: string) {
  if (value.trim() === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatPullRequestCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function DiffToolbar({
  allCollapsed,
  appColorScheme,
  config,
  diffStyle,
  diffThemeId,
  showBackground,
  showLineNumbers,
  isLocal,
  baseRef,
  onColorSchemeChange,
  onDiffStyleToggle,
  orderBy,
  orderDir,
  onOrderByChange,
  onOrderDirToggle,
  onDiffThemeChange,
  onSettingsOpenChange,
  onSidebarToggle,
  onSubmitPendingComments,
  onToggleAllCollapsed,
  pendingCommentCount,
  pullRequestInfo,
  wordWrap,
  collapseRemovals,
  hideReviewed,
  prUrl,
  selectedDiffThemeLabel,
  setShowBackground,
  setShowLineNumbers,
  setWordWrap,
  setCollapseRemovals,
  setHideReviewed,
  settingsOpen,
  sidebarOpen,
  submittingPendingComments,
}: {
  allCollapsed: boolean;
  appColorScheme: AppColorScheme;
  config: AppConfig;
  diffStyle: DiffStyle;
  diffThemeId: DiffThemeId;
  showBackground: boolean;
  showLineNumbers: boolean;
  isLocal: boolean;
  baseRef?: string;
  onColorSchemeChange: (value: AppColorScheme) => void;
  onDiffStyleToggle: () => void;
  orderBy: DiffOrderBy;
  orderDir: DiffOrderDir;
  onOrderByChange: (value: DiffOrderBy) => void;
  onOrderDirToggle: () => void;
  onDiffThemeChange: (value: DiffThemeId) => void;
  onSettingsOpenChange: (open: boolean) => void;
  onSidebarToggle: () => void;
  onSubmitPendingComments: () => void;
  onToggleAllCollapsed: () => void;
  pendingCommentCount: number;
  pullRequestInfo: PullRequestInfo | null;
  wordWrap: boolean;
  collapseRemovals: boolean;
  hideReviewed: boolean;
  prUrl: string;
  selectedDiffThemeLabel: string;
  setShowBackground: (value: boolean) => void;
  setShowLineNumbers: (value: boolean) => void;
  setWordWrap: (value: boolean) => void;
  setCollapseRemovals: (value: boolean) => void;
  setHideReviewed: (value: boolean) => void;
  settingsOpen: boolean;
  sidebarOpen: boolean;
  submittingPendingComments: boolean;
}) {
  const remoteTitle = pullRequestTitle(prUrl);
  const baseBranch = pullRequestInfo ? pullRequestBranchLabel(pullRequestInfo, "base") : "";
  const headBranch = pullRequestInfo ? pullRequestBranchLabel(pullRequestInfo, "head") : "";
  const createdAt = pullRequestInfo ? formatPullRequestDate(pullRequestInfo.createdAt) : "";
  const updatedAt = pullRequestInfo ? formatPullRequestDate(pullRequestInfo.updatedAt) : "";

  return (
    <header className="flex shrink-0 flex-nowrap items-center gap-2.5 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={headerIconButtonClass}
        onClick={onSidebarToggle}
        aria-pressed={sidebarOpen}
        aria-label="Show file tree"
        title="Show file tree"
      >
        <PanelLeft size={14} />
      </Button>

      {isLocal ? (
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate text-[13px] text-neutral-500 dark:text-neutral-400"
            title={config.cwd || "current directory"}
          >
            {displayLocalPath(config.cwd)}
          </span>
          {config.gitBranch.trim() !== "" && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[12px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              title={`Branch: ${config.gitBranch.trim()}`}
            >
              <GitBranch size={12} />
              <span className="truncate">{config.gitBranch.trim()}</span>
            </span>
          )}
          {baseRef && baseRef.trim() !== "" && (
            <>
              <ArrowLeft size={12} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[12px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                title={`Base: ${baseRef.trim()}`}
              >
                <GitBranch size={12} />
                <span className="truncate">{baseRef.trim()}</span>
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate text-[13px] text-neutral-500 dark:text-neutral-400"
            title={prUrl}
          >
            {remoteTitle.repo}
          </span>
          {remoteTitle.pullRequest !== "" && (
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[12px] text-neutral-600 outline-none transition-colors hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                    aria-label={`Pull request ${remoteTitle.pullRequest} overview`}
                    title={`Pull request ${remoteTitle.pullRequest}`}
                  >
                    <GitPullRequest size={12} />
                    <span className="truncate">{remoteTitle.pullRequest}</span>
                  </button>
                }
              />
              <PopoverContent
                align="start"
                sideOffset={8}
                className="w-[460px] max-w-[calc(100vw-24px)] gap-3 p-3"
              >
                {pullRequestInfo ? (
                  <>
                    {baseBranch !== "" && headBranch !== "" && (
                      <div
                        className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground"
                        title={`${headBranch} into ${baseBranch}`}
                      >
                        <span className="min-w-0 truncate">{baseBranch}</span>
                        <ArrowLeft size={12} className="shrink-0" />
                        <span className="min-w-0 truncate">{headBranch}</span>
                      </div>
                    )}
                    <PopoverHeader className="gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${pullRequestStatusClass(pullRequestInfo)}`}
                        >
                          {pullRequestStatus(pullRequestInfo)}
                        </span>
                        {pullRequestInfo.author !== "" && (
                          <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                            {pullRequestInfo.author}
                          </span>
                        )}
                      </div>
                      <PopoverTitle className="line-clamp-2 text-sm leading-snug">
                        {pullRequestInfo.title || remoteTitle.pullRequest}
                      </PopoverTitle>
                      {(createdAt !== "" || updatedAt !== "") && (
                        <PopoverDescription className="text-xs">
                          {createdAt !== "" ? `Opened ${createdAt}` : ""}
                          {createdAt !== "" && updatedAt !== "" ? " · " : ""}
                          {updatedAt !== "" ? `Updated ${updatedAt}` : ""}
                        </PopoverDescription>
                      )}
                    </PopoverHeader>
                    <div className="grid grid-cols-4 gap-2 text-center text-xs">
                      <div className="rounded-md bg-muted px-2 py-1.5">
                        <div className="font-medium text-green-600 dark:text-green-400">
                          +{formatPullRequestCount(pullRequestInfo.additions)}
                        </div>
                        <div className="text-muted-foreground">Added</div>
                      </div>
                      <div className="rounded-md bg-muted px-2 py-1.5">
                        <div className="font-medium text-red-600 dark:text-red-400">
                          -{formatPullRequestCount(pullRequestInfo.deletions)}
                        </div>
                        <div className="text-muted-foreground">Deleted</div>
                      </div>
                      <div className="rounded-md bg-muted px-2 py-1.5">
                        <div className="font-medium">
                          {formatPullRequestCount(pullRequestInfo.changedFiles)}
                        </div>
                        <div className="text-muted-foreground">Files</div>
                      </div>
                      <div className="rounded-md bg-muted px-2 py-1.5">
                        <div className="font-medium">
                          {formatPullRequestCount(pullRequestInfo.commits)}
                        </div>
                        <div className="text-muted-foreground">Commits</div>
                      </div>
                    </div>
                  </>
                ) : (
                  <PopoverHeader>
                    <PopoverTitle>{remoteTitle.pullRequest}</PopoverTitle>
                    <PopoverDescription>Pull request details are unavailable.</PopoverDescription>
                  </PopoverHeader>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        {pendingCommentCount > 0 && (
          <Button
            type="button"
            size="xs"
            className="h-7 border-[#2a9147] bg-[#238636] px-2 text-xs text-white hover:bg-[#2ea043] focus-visible:border-[#2a9147] focus-visible:ring-[#2ea043]/35"
            onClick={onSubmitPendingComments}
            disabled={submittingPendingComments}
            aria-label={`Submit ${pendingCommentCount} pending ${pendingCommentCount === 1 ? "comment" : "comments"}`}
            title={`Submit ${pendingCommentCount} pending ${pendingCommentCount === 1 ? "comment" : "comments"}`}
          >
            <SendHorizontal size={13} />
            <span>{submittingPendingComments ? "Submitting" : "Submit comments"}</span>
            <span className="rounded-full bg-white/20 px-1 text-[10px] tabular-nums text-white">
              {pendingCommentCount}
            </span>
          </Button>
        )}

        {!isLocal && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={headerIconLinkClass}
            aria-label="Open source in new tab"
            title="Open source in new tab"
          >
            <ExternalLink size={14} />
          </a>
        )}

        <span className="mx-1 h-3 w-px shrink-0 bg-neutral-300 dark:bg-neutral-600" />

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={headerIconButtonClass}
          onClick={onToggleAllCollapsed}
          aria-pressed={allCollapsed}
          aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
          title={allCollapsed ? "Expand all files" : "Collapse all files"}
        >
          {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
        </Button>

        <Suspense fallback={null}>
          <DiffSettingsPopover
            open={settingsOpen}
            onOpenChange={onSettingsOpenChange}
            appColorScheme={appColorScheme}
            onColorSchemeChange={onColorSchemeChange}
            diffStyle={diffStyle}
            onDiffStyleToggle={onDiffStyleToggle}
            orderBy={orderBy}
            orderDir={orderDir}
            onOrderByChange={onOrderByChange}
            onOrderDirToggle={onOrderDirToggle}
            diffThemeId={diffThemeId}
            onDiffThemeChange={onDiffThemeChange}
            selectedDiffThemeLabel={selectedDiffThemeLabel}
            showBackground={showBackground}
            setShowBackground={setShowBackground}
            showLineNumbers={showLineNumbers}
            setShowLineNumbers={setShowLineNumbers}
            wordWrap={wordWrap}
            setWordWrap={setWordWrap}
            collapseRemovals={collapseRemovals}
            setCollapseRemovals={setCollapseRemovals}
            hideReviewed={hideReviewed}
            setHideReviewed={setHideReviewed}
          />
        </Suspense>
      </div>
    </header>
  );
}
