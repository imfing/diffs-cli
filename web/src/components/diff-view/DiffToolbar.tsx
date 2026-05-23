import { lazy, Suspense } from 'react';
import { ExternalLink, Columns2, Rows3, PanelLeft, FoldVertical, UnfoldVertical } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import type { AppColorScheme } from '@/lib/colorScheme';
import type { AppConfig, DiffStyle, DiffThemeId } from './types';
import { displayLocalPath } from './helpers';
import { PullRequestUrlForm } from './PullRequestUrlForm';

const DiffSettingsPopover = lazy(() =>
  import('./DiffSettingsPopover').then((m) => ({ default: m.DiffSettingsPopover }))
);

const headerIconButtonClass = 'size-7 shrink-0 p-0 text-muted-foreground [&_svg]:size-[15px]';
const headerIconLinkClass = buttonVariants({
  variant: 'ghost',
  size: 'icon-sm',
  className: `${headerIconButtonClass} no-underline`,
});

export function DiffToolbar({
  allCollapsed,
  appColorScheme,
  config,
  diffStyle,
  diffThemeId,
  showBackground,
  showLineNumbers,
  isLocal,
  onColorSchemeChange,
  onDiffStyleToggle,
  onDiffThemeChange,
  onNavigate,
  onSettingsOpenChange,
  onSidebarToggle,
  onToggleAllCollapsed,
  wordWrap,
  prUrl,
  selectedDiffThemeLabel,
  setShowBackground,
  setShowLineNumbers,
  setWordWrap,
  settingsOpen,
  sidebarOpen,
}: {
  allCollapsed: boolean;
  appColorScheme: AppColorScheme;
  config: AppConfig;
  diffStyle: DiffStyle;
  diffThemeId: DiffThemeId;
  showBackground: boolean;
  showLineNumbers: boolean;
  isLocal: boolean;
  onColorSchemeChange: (value: AppColorScheme) => void;
  onDiffStyleToggle: () => void;
  onDiffThemeChange: (value: DiffThemeId) => void;
  onNavigate: (path: string) => void;
  onSettingsOpenChange: (open: boolean) => void;
  onSidebarToggle: () => void;
  onToggleAllCollapsed: () => void;
  wordWrap: boolean;
  prUrl: string;
  selectedDiffThemeLabel: string;
  setShowBackground: (value: boolean) => void;
  setShowLineNumbers: (value: boolean) => void;
  setWordWrap: (value: boolean) => void;
  settingsOpen: boolean;
  sidebarOpen: boolean;
}) {
  return (
    <header className="flex shrink-0 flex-nowrap items-center gap-2.5 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
      {isLocal ? (
        <div
          className="mr-auto min-w-0 truncate px-2 text-[13px] text-neutral-500 dark:text-neutral-400"
          title={config.cwd || 'current directory'}
        >
          {displayLocalPath(config.cwd)}
          {config.gitBranch.trim() !== '' ? ` on ${config.gitBranch.trim()}` : ''}
        </div>
      ) : (
        <PullRequestUrlForm key={prUrl} prUrl={prUrl} onNavigate={onNavigate} />
      )}

      <div className="flex shrink-0 items-center gap-0.5">
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
          onClick={onDiffStyleToggle}
          aria-label={diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view'}
          title={diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view'}
        >
          {diffStyle === 'split' ? <Rows3 /> : <Columns2 />}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={headerIconButtonClass}
          onClick={onToggleAllCollapsed}
          aria-pressed={allCollapsed}
          aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
          title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
        >
          {allCollapsed ? <UnfoldVertical /> : <FoldVertical />}
        </Button>

        <Suspense fallback={null}>
          <DiffSettingsPopover
            open={settingsOpen}
            onOpenChange={onSettingsOpenChange}
            appColorScheme={appColorScheme}
            onColorSchemeChange={onColorSchemeChange}
            diffThemeId={diffThemeId}
            onDiffThemeChange={onDiffThemeChange}
            selectedDiffThemeLabel={selectedDiffThemeLabel}
            showBackground={showBackground}
            setShowBackground={setShowBackground}
            showLineNumbers={showLineNumbers}
            setShowLineNumbers={setShowLineNumbers}
            wordWrap={wordWrap}
            setWordWrap={setWordWrap}
          />
        </Suspense>
      </div>
    </header>
  );
}
