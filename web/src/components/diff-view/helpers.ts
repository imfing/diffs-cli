import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import type {
  DiffOrderBy,
  DiffOrderByOption,
  DiffOrderDir,
  DiffStyle,
  DiffThemeId,
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

export function isDiffThemeId(value: unknown): value is DiffThemeId {
  return typeof value === "string" && diffThemeOptions.some((option) => option.id === value);
}

export function isDiffStyle(value: unknown): value is DiffStyle {
  return value === "split" || value === "unified";
}

export const diffOrderByOptions: readonly DiffOrderByOption[] = [
  { id: "path", label: "Path" },
  { id: "changes", label: "Changes" },
  { id: "type", label: "File type" },
];

export function isDiffOrderBy(value: unknown): value is DiffOrderBy {
  return value === "path" || value === "changes" || value === "type";
}

export function isDiffOrderDir(value: unknown): value is DiffOrderDir {
  return value === "asc" || value === "desc";
}

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

export function threadRangeLabel(thread: ReviewThread): string | null {
  const endLine = threadEndLine(thread);
  if (endLine === thread.line && threadEndSide(thread) === thread.side) return null;
  return `Lines ${thread.line}-${endLine}`;
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

// Do NOT decode C-style escapes (\NNN, \t, …) in quoted paths — the patch parser leaves them as-is.
function stripDiffPathPrefix(value: string): string {
  let path = value;
  const tab = path.indexOf("\t");
  if (tab !== -1) path = path.slice(0, tab);
  path = path.trim();
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}

function patchTargetPath(block: readonly string[]): string | null {
  let fromPath: string | null = null;
  for (const line of block) {
    if (line.startsWith("+++ ")) {
      const path = stripDiffPathPrefix(line.slice(4));
      if (path !== "" && path !== "/dev/null") return path;
    } else if (line.startsWith("rename to ")) {
      return stripDiffPathPrefix(line.slice(10));
    } else if (line.startsWith("--- ") && fromPath == null) {
      const path = stripDiffPathPrefix(line.slice(4));
      if (path !== "" && path !== "/dev/null") fromPath = path;
    }
  }
  if (fromPath != null) return fromPath;
  const match = / b\/(.+)$/.exec(block[0]?.slice("diff --git ".length) ?? "");
  return match ? match[1].trim() : null;
}

// Byte-for-byte slice per diff --git block; preserves exact git output for copy-diff.
export function splitPatchByFile(patch: string | null): Map<string, string> {
  const sections = new Map<string, string>();
  if (!patch) return sections;
  const starts: number[] = [];
  let offset = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) starts.push(offset);
    offset += line.length + 1; // + 1 for the "\n" consumed by split
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : patch.length;
    const section = patch.slice(starts[i], end);
    const name = patchTargetPath(section.split("\n"));
    if (name != null) sections.set(name, section);
  }
  return sections;
}
