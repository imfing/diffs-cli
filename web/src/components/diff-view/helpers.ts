import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import type {
  DiffOrderBy,
  DiffOrderByOption,
  DiffOrderDir,
  DiffThemeOption,
  ColorSchemeOption,
  ReviewThread,
} from "./types";

export const diffThemeOptions: readonly DiffThemeOption[] = [
  {
    id: "pierre",
    label: "Pierre",
    theme: { dark: "pierre-dark", light: "pierre-light" },
    themeType: "system",
  },
  {
    id: "pierre-soft",
    label: "Pierre Soft",
    theme: { dark: "pierre-dark-soft", light: "pierre-light-soft" },
    themeType: "system",
  },
  {
    id: "github",
    label: "GitHub",
    theme: { dark: "github-dark", light: "github-light" },
    themeType: "system",
  },
  { id: "dark-plus", label: "Dark Plus", theme: "dark-plus" },
  { id: "light-plus", label: "Light Plus", theme: "light-plus" },
  { id: "one-dark-pro", label: "One Dark Pro", theme: "one-dark-pro" },
  { id: "one-light", label: "One Light", theme: "one-light" },
  { id: "monokai", label: "Monokai", theme: "monokai" },
  { id: "night-owl", label: "Night Owl", theme: "night-owl" },
  { id: "tokyo-night", label: "Tokyo Night", theme: "tokyo-night" },
];

export const colorSchemeOptions: readonly ColorSchemeOption[] = [
  { id: "system", label: "System", icon: IconDeviceDesktop },
  { id: "light", label: "Light", icon: IconSun },
  { id: "dark", label: "Dark", icon: IconMoon },
];

export const diffOrderByOptions: readonly DiffOrderByOption[] = [
  { id: "path", label: "Path" },
  { id: "changes", label: "Changes" },
  { id: "type", label: "File type" },
];

function fileChangeCount(file: FileDiffMetadata): number {
  let count = 0;
  for (const hunk of file.hunks) count += hunk.additionLines + hunk.deletionLines;
  return count;
}

function fileExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// An empty head means the checked-out branch; dirty changes only apply there.
export function branchDiffHref(base: string, head: string, includeDirty: boolean) {
  const params = new URLSearchParams();
  params.set("base", base);
  if (head) params.set("head", head);
  else if (includeDirty) params.set("dirty", "1");
  return `/branch?${params.toString()}`;
}

export function sortFiles(
  files: readonly FileDiffMetadata[],
  orderBy: DiffOrderBy,
  dir: DiffOrderDir,
): FileDiffMetadata[] {
  const sign = dir === "asc" ? 1 : -1;
  const primary = (a: FileDiffMetadata, b: FileDiffMetadata): number => {
    if (orderBy === "changes") return fileChangeCount(a) - fileChangeCount(b);
    if (orderBy === "type") return fileExtension(a.name).localeCompare(fileExtension(b.name));
    return a.name.localeCompare(b.name);
  };
  return [...files].sort((a, b) => {
    const result = primary(a, b);
    return (result !== 0 ? result : a.name.localeCompare(b.name)) * sign;
  });
}

export function selectedRangeSide(range: SelectedLineRange): "additions" | "deletions" {
  return range.side ?? "additions";
}

export function selectedRangeEndSide(range: SelectedLineRange): "additions" | "deletions" {
  return range.endSide ?? selectedRangeSide(range);
}

export function selectedRangeEndLine(range: SelectedLineRange): number {
  return range.end || range.start;
}

export function threadEndLine(thread: ReviewThread): number {
  return thread.endLine || thread.line;
}

export function threadEndSide(thread: ReviewThread): "additions" | "deletions" {
  return thread.endSide ?? thread.side;
}

export function threadLineLabel(thread: ReviewThread): string {
  const sign = thread.side === "additions" ? "+" : "-";
  const endLine = threadEndLine(thread);
  const endSide = threadEndSide(thread);
  if (endLine === thread.line && endSide === thread.side) return `Line ${sign}${thread.line}`;
  if (endSide === thread.side) return `Lines ${sign}${thread.line}-${sign}${endLine}`;
  const endSign = endSide === "additions" ? "+" : "-";
  return `Lines ${sign}${thread.line}-${endSign}${endLine}`;
}

export function latestThreadComment(thread: ReviewThread) {
  return thread.comments[thread.comments.length - 1];
}

function localDirTitle(cwd: string): string {
  const normalized = cwd.trim().replace(/[\\/]+$/, "");
  if (normalized === "") return "local";
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized;
}

export function displayLocalPath(cwd: string): string {
  const normalized = cwd.trim().replace(/[\\/]+$/, "");
  if (normalized === "") return "current directory";
  return normalized.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

export function localRepoTitle(cwd: string, branch: string): string {
  const dir = localDirTitle(cwd);
  const cleanedBranch = branch.trim();
  return cleanedBranch === "" ? dir : `${dir} (${cleanedBranch})`;
}

export const headerIconButtonClass =
  "size-7 shrink-0 p-0 text-muted-foreground [&_svg]:size-[15px]";

export function fileBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// PR URL pathname matches the app's /:org/:repo/pull/:number route, so it doubles as the nav target.
export function prDiffPathFromUrl(prUrl: string): string | undefined {
  try {
    return new URL(prUrl).pathname;
  } catch {
    return undefined;
  }
}

// Byte-for-byte `diff --git` blocks for copy-diff. parsePatchFiles returns one
// file per block in patch order; on any mismatch return nothing (and say so)
// rather than pair a file with the wrong block.
export function splitPatchByFile(
  patch: string | null,
  files: readonly FileDiffMetadata[],
): Map<string, string> {
  const blocks = (patch ?? "")
    .split(/^(?=diff --git )/m)
    .filter((b) => b.startsWith("diff --git "));
  if (blocks.length !== files.length) {
    if (files.length > 0) {
      console.warn(
        `Copy diff unavailable: ${blocks.length} patch blocks vs ${files.length} parsed files`,
      );
    }
    return new Map();
  }
  return new Map(files.map((file, i) => [file.name, blocks[i]]));
}
