import type { DiffsThemeNames, SelectedLineRange, ThemesType, ThemeTypes } from '@pierre/diffs';
import type { AppColorScheme } from '@/lib/colorScheme';

export type DiffStyle = 'split' | 'unified';
export type DiffThemeId =
  | 'pierre'
  | 'github'
  | 'dark-plus'
  | 'light-plus'
  | 'one-dark-pro'
  | 'one-light'
  | 'monokai'
  | 'night-owl'
  | 'tokyo-night';

export type DiffThemeOption = {
  id: DiffThemeId;
  label: string;
  theme: DiffsThemeNames | ThemesType;
  themeType?: ThemeTypes;
};

export type ColorSchemeOption = {
  id: AppColorScheme;
  label: string;
};

export type PatchLoadState = {
  error: string | null;
  patch: string | null;
  requestKey: string;
  status: 'loading' | 'loaded' | 'error';
};

export type AppConfig = {
  colorScheme?: string;
  diffStyle?: string;
  diffTheme?: string;
  cwd: string;
  gitBranch: string;
  githubHost: string;
  lineBackgrounds?: boolean;
  lineNumbers?: boolean;
  wordWrap?: boolean;
};

export type ReviewComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

export type ReviewThread = {
  id: string;
  provider: string;
  branch: string;
  path: string;
  side: 'additions' | 'deletions';
  line: number;
  endSide?: 'additions' | 'deletions';
  endLine?: number;
  status: 'open' | 'resolved';
  comments: ReviewComment[];
};

export type CommentTarget = {
  itemId: string;
  path: string;
  line: number;
  side: 'additions' | 'deletions';
  endLine: number;
  endSide: 'additions' | 'deletions';
  range: SelectedLineRange;
};

export type AnnotationMeta =
  | { type: 'input' }
  | { type: 'comment'; thread: ReviewThread };

export type CodeViewLineSelection = {
  id: string;
  range: SelectedLineRange;
};
