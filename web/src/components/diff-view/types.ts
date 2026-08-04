import type { DiffsThemeNames, SelectedLineRange, ThemesType, ThemeTypes } from "@pierre/diffs";
import type { TablerIcon } from "@tabler/icons-react";
import type { AppColorScheme } from "@/lib/colorScheme";

export type DiffStyle = "split" | "unified";
export type DiffOrderBy = "path" | "changes" | "type";
export type DiffOrderDir = "asc" | "desc";

export type DiffOrderByOption = {
  id: DiffOrderBy;
  label: string;
};
export type DiffThemeId =
  | "pierre"
  | "github"
  | "dark-plus"
  | "light-plus"
  | "one-dark-pro"
  | "one-light"
  | "monokai"
  | "night-owl"
  | "tokyo-night";

export type DiffThemeOption = {
  id: DiffThemeId;
  label: string;
  theme: DiffsThemeNames | ThemesType;
  themeType?: ThemeTypes;
};

export type ColorSchemeOption = {
  id: AppColorScheme;
  label: string;
  icon: TablerIcon;
};

export type PatchLoadState = {
  error: string | null;
  patch: string | null;
  status: "loading" | "loaded" | "error";
};

export type AppConfig = {
  codeFontFamily?: string;
  colorScheme?: string;
  diffStyle?: string;
  diffTheme?: string;
  cwd: string;
  gitBranch: string;
  githubHost: string;
  lineBackgrounds?: boolean;
  lineNumbers?: boolean;
  uiFontFamily?: string;
  wordWrap?: boolean;
};

export type PullRequestInfo = {
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  headRef: string;
  headLabel: string;
  headRepo: string;
  baseRef: string;
  baseLabel: string;
  baseRepo: string;
};

export type ReviewComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

export type PendingCommentDraft = {
  path: string;
  side: "additions" | "deletions";
  line: number;
  endSide: "additions" | "deletions";
  endLine: number;
  body: string;
};

export type ReviewThread = {
  id: string;
  provider: string;
  branch: string;
  path: string;
  side: "additions" | "deletions";
  line: number;
  endSide?: "additions" | "deletions";
  endLine?: number;
  status: "open" | "resolved";
  comments: ReviewComment[];
  replyToId?: number;
  url?: string;
  pending?: boolean;
  draft?: PendingCommentDraft;
};

export type CommentTarget = {
  itemId: string;
  path: string;
  line: number;
  side: "additions" | "deletions";
  endLine: number;
  endSide: "additions" | "deletions";
  range: SelectedLineRange;
};

export type AnnotationMeta = { type: "input" } | { type: "comment"; thread: ReviewThread };

export type CodeViewLineSelection = {
  id: string;
  range: SelectedLineRange;
};

export type DiffSettingsProps = {
  appColorScheme: AppColorScheme;
  onColorSchemeChange: (value: AppColorScheme) => void;
  diffStyle: DiffStyle;
  onDiffStyleToggle: () => void;
  orderBy: DiffOrderBy;
  orderDir: DiffOrderDir;
  onOrderByChange: (value: DiffOrderBy) => void;
  onOrderDirToggle: () => void;
  diffThemeId: DiffThemeId;
  onDiffThemeChange: (value: DiffThemeId) => void;
  selectedDiffThemeLabel: string;
  showBackground: boolean;
  setShowBackground: (value: boolean) => void;
  showLineNumbers: boolean;
  setShowLineNumbers: (value: boolean) => void;
  wordWrap: boolean;
  setWordWrap: (value: boolean) => void;
  collapseRemovals: boolean;
  setCollapseRemovals: (value: boolean) => void;
  hideReviewed: boolean;
  setHideReviewed: (value: boolean) => void;
  onShortcutsOpen: () => void;
};
