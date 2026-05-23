import {
  IconExternalLink as ExternalLink,
  IconLayoutColumns as SplitView,
  IconLayoutList as UnifiedView,
  IconLayoutSidebar as PanelLeft,
  IconSettings as Settings,
} from '@tabler/icons-react';
import { FoldVertical, UnfoldVertical } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { AppColorScheme } from '@/lib/colorScheme';
import type { AppConfig, DiffStyle, DiffThemeId } from './types';
import { colorSchemeOptions, diffThemeOptions, displayLocalPath } from './helpers';
import { PullRequestUrlForm } from './PullRequestUrlForm';

const headerIconButtonClass = 'size-7 shrink-0 p-0 text-muted-foreground [&_svg]:size-[15px]';
const headerIconLinkClass = buttonVariants({
  variant: 'ghost',
  size: 'icon-sm',
  className: `${headerIconButtonClass} no-underline`,
});
const settingsRowClass = 'flex items-center justify-between gap-4 py-1.5 text-sm';

export function DiffToolbar({
  allCollapsed,
  appColorScheme,
  commentCount,
  config,
  diffStyle,
  diffThemeId,
  disableBackground,
  disableLineNumbers,
  isLocal,
  onColorSchemeChange,
  onDiffStyleToggle,
  onDiffThemeChange,
  onNavigate,
  onSettingsOpenChange,
  onSidebarToggle,
  onSubmitReview,
  onToggleAllCollapsed,
  overflow,
  prUrl,
  selectedDiffThemeLabel,
  setDisableBackground,
  setDisableLineNumbers,
  setOverflow,
  settingsOpen,
  sidebarOpen,
}: {
  allCollapsed: boolean;
  appColorScheme: AppColorScheme;
  commentCount: number;
  config: AppConfig;
  diffStyle: DiffStyle;
  diffThemeId: DiffThemeId;
  disableBackground: boolean;
  disableLineNumbers: boolean;
  isLocal: boolean;
  onColorSchemeChange: (value: AppColorScheme) => void;
  onDiffStyleToggle: () => void;
  onDiffThemeChange: (value: DiffThemeId) => void;
  onNavigate: (path: string) => void;
  onSettingsOpenChange: (open: boolean) => void;
  onSidebarToggle: () => void;
  onSubmitReview: () => void;
  onToggleAllCollapsed: () => void;
  overflow: 'scroll' | 'wrap';
  prUrl: string;
  selectedDiffThemeLabel: string;
  setDisableBackground: (value: boolean) => void;
  setDisableLineNumbers: (value: boolean) => void;
  setOverflow: (value: 'scroll' | 'wrap') => void;
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
          {diffStyle === 'split' ? <UnifiedView /> : <SplitView />}
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

        {!isLocal && commentCount > 0 && (
          <Button
            type="button"
            size="sm"
            onClick={onSubmitReview}
          >
            Submit Review ({commentCount})
          </Button>
        )}

        <Popover open={settingsOpen} onOpenChange={onSettingsOpenChange}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={headerIconButtonClass}
                aria-label="Settings"
                title="Settings"
              >
                <Settings size={14} />
              </Button>
            }
          />
          <PopoverContent align="end" sideOffset={8} className="w-[300px] gap-3 p-3">
            <PopoverHeader>
              <PopoverTitle>Settings</PopoverTitle>
            </PopoverHeader>
            <div className="flex flex-col gap-1">
              <label className={settingsRowClass}>
                <span>Color scheme</span>
                <Select
                  value={appColorScheme}
                  onValueChange={(value) => {
                    onColorSchemeChange(value as AppColorScheme);
                  }}
                >
                  <SelectTrigger size="sm" className="h-7 w-[134px] text-xs">
                    <SelectValue>
                      {(value) =>
                        colorSchemeOptions.find((option) => option.id === value)?.label ?? 'System'
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectGroup>
                      {colorSchemeOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id} className="text-xs">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <label className={settingsRowClass}>
                <span>Diff theme</span>
                <Select
                  value={diffThemeId}
                  onValueChange={(value) => {
                    onDiffThemeChange(value as DiffThemeId);
                  }}
                >
                  <SelectTrigger size="sm" className="h-7 w-[134px] text-xs">
                    <SelectValue>
                      {(value) =>
                        diffThemeOptions.find((option) => option.id === value)?.label ?? selectedDiffThemeLabel
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end" className="max-h-[260px]">
                    <SelectGroup>
                      {diffThemeOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id} className="text-xs">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <label className={settingsRowClass}>
                <span>Line backgrounds</span>
                <Switch size="sm" checked={!disableBackground} onCheckedChange={(checked) => setDisableBackground(!checked)} />
              </label>
              <label className={settingsRowClass}>
                <span>Line numbers</span>
                <Switch size="sm" checked={!disableLineNumbers} onCheckedChange={(checked) => setDisableLineNumbers(!checked)} />
              </label>
              <label className={settingsRowClass}>
                <span>Word wrap</span>
                <Switch size="sm" checked={overflow === 'wrap'} onCheckedChange={(checked) => setOverflow(checked ? 'wrap' : 'scroll')} />
              </label>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
