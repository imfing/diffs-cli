import { lazy, Suspense, useState, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconFileDiff,
  IconFileExport,
  IconGitBranch,
  IconGitPullRequest,
  IconLayoutSidebar,
  IconSend,
  IconSwitchVertical,
  IconDots,
} from "@tabler/icons-react";
import { siGithub, type SimpleIcon } from "simple-icons";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiFetch } from "@/lib/api";
import type { AppConfig, DiffSettingsProps, PullRequestInfo } from "./types";
import { displayLocalPath, headerIconButtonClass } from "./helpers";

const DiffSettingsPopover = lazy(() =>
  import("./DiffSettingsPopover").then((m) => ({ default: m.DiffSettingsPopover })),
);

function SimpleBrandIcon({ icon, ...props }: { icon: SimpleIcon } & SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" {...props}>
      <path fill="currentColor" d={icon.path} />
    </svg>
  );
}

function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return <SimpleBrandIcon icon={siGithub} {...props} />;
}

// Menu entries in display order; a missing href hides the entry.
export type ToolbarLink = [href: string | undefined, kind: keyof typeof linkMeta];
const linkMeta = {
  branch: [IconGitBranch, "View branch diff"],
  local: [IconFileDiff, "View local diff"],
  pr: [IconGitPullRequest, "View PR diff"],
  "github-pr": [GitHubIcon, "Open GitHub Pull request"],
  "github-repo": [GitHubIcon, "Open GitHub repository"],
} as const;

const chipClass =
  "inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[12px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
const chipButtonClass = `${chipClass} cursor-pointer outline-none transition-colors hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-neutral-700`;

function BranchChip({ label, title }: { label: string; title: string }) {
  return (
    <span className={chipClass} title={title}>
      <IconGitBranch size={12} />
      <span className="truncate">{label}</span>
    </span>
  );
}

// An empty head means the checked-out branch; dirty changes only apply there.
function branchDiffHref(base: string, head: string, includeDirty: boolean) {
  const params = new URLSearchParams();
  params.set("base", base);
  if (head) params.set("head", head);
  else if (includeDirty) params.set("dirty", "1");
  return `/branch?${params.toString()}`;
}

function BranchSwitcher({
  role,
  current,
  hrefFor,
}: {
  role: "Base" | "Head";
  current: string;
  hrefFor: (name: string) => string;
}) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadBranches = () => {
    setLoading(true);
    apiFetch<{ branches: string[] }>("/api/branches")
      .then((data) => {
        const names = [...(data.branches ?? [])];
        if (current !== "" && !names.includes(current)) names.unshift(current);
        setBranches(names);
      })
      .catch(() => setBranches(current !== "" ? [current] : []))
      .finally(() => setLoading(false));
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) loadBranches();
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={`${chipButtonClass} max-w-[12rem]`}
            title={`${role}: ${current}. Click to switch.`}
            aria-label={`${role} branch ${current}. Click to switch.`}
          >
            {role === "Head" && <IconGitBranch size={12} className="shrink-0" />}
            <span className="min-w-0 truncate">{current}</span>
            <IconChevronDown size={12} className="shrink-0 opacity-60" />
          </button>
        }
      />
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-44 overflow-y-auto [&_[data-slot=dropdown-menu-item]]:text-[12px]"
      >
        {loading && branches == null ? (
          <div className="px-2 py-1.5 text-[12px] text-muted-foreground">Loading branches…</div>
        ) : (branches?.length ?? 0) === 0 ? (
          <div className="px-2 py-1.5 text-[12px] text-muted-foreground">No branches found</div>
        ) : (
          branches?.map((name) => {
            const selected = name === current;
            return (
              <DropdownMenuItem
                key={name}
                render={<Link to={hrefFor(name)} />}
                className={selected ? "font-medium" : undefined}
                aria-current={selected ? "true" : undefined}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {selected ? <IconCheck size={14} /> : null}
                </span>
                <span className="min-w-0 truncate">{name}</span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolbarIconButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={headerIconButtonClass}
            onClick={onClick}
            aria-pressed={pressed}
            aria-label={label}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function pullRequestTitle(prUrl: string) {
  try {
    const url = new URL(prUrl);
    const [owner, repo, kind, number] = url.pathname.split("/").filter(Boolean);
    if (owner && repo && kind === "pull" && number) {
      return { repo: `${owner}/${repo}`, pullRequest: `#${number}` };
    }
  } catch {}
  return { repo: prUrl, pullRequest: "" };
}

const pullRequestStatusClass: Record<PullRequestInfo["status"], string> = {
  Open: "bg-[#1f883d] text-white",
  Merged: "bg-[#8250df] text-white",
  Draft: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
  Closed: "bg-[#cf222e] text-white",
};

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

const count = new Intl.NumberFormat();

export function DiffToolbar({
  allCollapsed,
  config,
  isLocal,
  baseRef,
  headRef = "",
  includeDirty = false,
  onSidebarToggle,
  onSubmitPendingComments,
  onToggleAllCollapsed,
  onExport,
  exporting,
  onMenuOpen,
  links,
  pendingCommentCount,
  pullRequestInfo,
  prUrl,
  settings,
  sidebarOpen,
  submittingPendingComments,
}: {
  allCollapsed: boolean;
  config: AppConfig;
  isLocal: boolean;
  baseRef?: string;
  headRef?: string;
  includeDirty?: boolean;
  onSidebarToggle: () => void;
  onSubmitPendingComments: () => void;
  onToggleAllCollapsed: () => void;
  onExport: () => void;
  exporting: boolean;
  onMenuOpen: () => void;
  links: readonly ToolbarLink[];
  pendingCommentCount: number;
  pullRequestInfo: PullRequestInfo | null;
  prUrl: string;
  settings: DiffSettingsProps;
  sidebarOpen: boolean;
  submittingPendingComments: boolean;
}) {
  const remoteTitle = pullRequestTitle(prUrl);
  const branchLabel = headRef || config.gitBranch.trim();
  const baseBranch = pullRequestInfo?.baseBranch ?? "";
  const headBranch = pullRequestInfo?.headBranch ?? "";
  const createdAt = pullRequestInfo ? formatPullRequestDate(pullRequestInfo.createdAt) : "";
  const updatedAt = pullRequestInfo ? formatPullRequestDate(pullRequestInfo.updatedAt) : "";
  const submitLabel = `Submit ${pendingCommentCount} pending ${pendingCommentCount === 1 ? "comment" : "comments"}`;

  return (
    <header className="flex shrink-0 flex-nowrap items-center gap-2.5 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900">
      <ToolbarIconButton label="Show file tree" onClick={onSidebarToggle} pressed={sidebarOpen}>
        <IconLayoutSidebar size={14} />
      </ToolbarIconButton>

      <div className="mr-auto flex min-w-0 items-center gap-2">
        {isLocal ? (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 truncate text-xs text-neutral-500 dark:text-neutral-400"
              title={config.cwd || "current directory"}
            >
              {displayLocalPath(config.cwd)}
            </span>
            {baseRef && baseRef.trim() !== "" ? (
              <>
                <BranchSwitcher
                  role="Base"
                  current={baseRef.trim()}
                  hrefFor={(name) => branchDiffHref(name, headRef, includeDirty)}
                />
                <IconArrowLeft
                  size={12}
                  className="shrink-0 text-neutral-400 dark:text-neutral-500"
                />
                <BranchSwitcher
                  role="Head"
                  current={branchLabel || "HEAD"}
                  hrefFor={(name) =>
                    branchDiffHref(
                      baseRef.trim(),
                      name === config.gitBranch.trim() ? "" : name,
                      includeDirty,
                    )
                  }
                />
              </>
            ) : (
              branchLabel !== "" && (
                <BranchChip label={branchLabel} title={`Branch: ${branchLabel}`} />
              )
            )}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 truncate text-xs text-neutral-500 dark:text-neutral-400"
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
                      className={chipButtonClass}
                      aria-label={`Pull request ${remoteTitle.pullRequest} overview`}
                      title={`Pull request ${remoteTitle.pullRequest}`}
                    >
                      <IconGitPullRequest size={12} />
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
                          <IconArrowLeft size={12} className="shrink-0" />
                          <span className="min-w-0 truncate">{headBranch}</span>
                        </div>
                      )}
                      <PopoverHeader className="gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${pullRequestStatusClass[pullRequestInfo.status]}`}
                          >
                            {pullRequestInfo.status}
                          </span>
                          {pullRequestInfo.author !== "" && (
                            <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                              {pullRequestInfo.author}
                            </span>
                          )}
                        </div>
                        <PopoverTitle className="line-clamp-2 text-xs leading-snug">
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
                        {(
                          [
                            [
                              `+${count.format(pullRequestInfo.additions)}`,
                              "Added",
                              "text-green-600 dark:text-green-400",
                            ],
                            [
                              `-${count.format(pullRequestInfo.deletions)}`,
                              "Deleted",
                              "text-red-600 dark:text-red-400",
                            ],
                            [count.format(pullRequestInfo.changedFiles), "Files", ""],
                            [count.format(pullRequestInfo.commits), "Commits", ""],
                          ] as const
                        ).map(([value, label, color]) => (
                          <div key={label} className="rounded-md bg-muted px-2 py-1.5">
                            <div className={`font-medium ${color}`}>{value}</div>
                            <div className="text-muted-foreground">{label}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <PopoverHeader className="text-[12px]">
                      <PopoverTitle>{remoteTitle.pullRequest}</PopoverTitle>
                      <PopoverDescription>Pull request details are unavailable.</PopoverDescription>
                    </PopoverHeader>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}
        <DropdownMenu onOpenChange={(open) => open && onMenuOpen()}>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={headerIconButtonClass}
                aria-label="More actions"
              >
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent
            align="start"
            className="[&_[data-slot=dropdown-menu-item]]:text-[12px]"
          >
            {links.map(([href, kind]) => {
              if (!href) return null;
              const [Icon, label] = linkMeta[kind];
              const external = !href.startsWith("/");
              return (
                <DropdownMenuItem
                  key={kind}
                  render={
                    external ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" />
                    ) : (
                      <Link to={href} />
                    )
                  }
                >
                  <Icon />
                  {label}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuItem onClick={onExport} disabled={exporting}>
              <IconFileExport />
              {exporting ? "Exporting…" : "Export as HTML"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {pendingCommentCount > 0 && (
          <Button
            type="button"
            size="xs"
            className="h-7 border-[#2a9147] bg-[#238636] px-2 text-xs text-white hover:bg-[#2ea043] focus-visible:border-[#2a9147] focus-visible:ring-[#2ea043]/35"
            onClick={onSubmitPendingComments}
            disabled={submittingPendingComments}
            aria-label={submitLabel}
            title={submitLabel}
          >
            <IconSend size={13} />
            <span>{submittingPendingComments ? "Submitting" : "Submit comments"}</span>
            <span className="rounded-full bg-white/20 px-1 text-[10px] tabular-nums text-white">
              {pendingCommentCount}
            </span>
          </Button>
        )}

        <ToolbarIconButton
          label={allCollapsed ? "Expand all files" : "Collapse all files"}
          onClick={onToggleAllCollapsed}
          pressed={allCollapsed}
        >
          <IconSwitchVertical />
        </ToolbarIconButton>

        <Suspense fallback={null}>
          <DiffSettingsPopover {...settings} />
        </Suspense>
      </div>
    </header>
  );
}
