import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  IconAdjustmentsHorizontal,
  IconColumns2,
  IconKeyboard,
  IconLayoutRows,
  IconSortAscending,
  IconSortDescending,
  type TablerIcon,
} from "@tabler/icons-react";
import { isAppColorScheme, type AppColorScheme } from "@/lib/colorScheme";
import type { DiffOrderBy, DiffOrderDir, DiffStyle, DiffThemeId } from "./types";
import {
  colorSchemeOptions,
  diffOrderByOptions,
  diffThemeOptions,
  headerIconButtonClass,
  isDiffOrderBy,
  isDiffThemeId,
} from "./helpers";

const settingsPanelClass =
  "w-[320px] rounded-[10px] border-border/80 p-2 shadow-[0_12px_32px_rgb(0_0_0_/_0.12)] ring-1 ring-foreground/5 dark:border-white/10 dark:bg-[#151516] dark:shadow-[0_16px_40px_rgb(0_0_0_/_0.38)] dark:ring-white/10";
const settingsGroupClass = "flex flex-col gap-0.5";
const settingsRowClass =
  "flex min-h-8 items-center justify-between gap-3 rounded-md px-2 text-[12px] font-[450] leading-none text-popover-foreground";
const settingsLabelClass = "min-w-0 text-muted-foreground";
const selectTriggerClass = "h-7 text-[12px] font-[450]";
const selectItemClass = "text-[12px]";

const diffStyleOptions = [
  { id: "split", label: "Split", icon: IconColumns2 },
  { id: "unified", label: "Unified", icon: IconLayoutRows },
] as const satisfies readonly { id: DiffStyle; label: string; icon: typeof IconColumns2 }[];

type SelectRowOption = { id: string; label: string; icon?: TablerIcon };

function SwitchRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <label className={settingsRowClass}>
      <span className={settingsLabelClass}>{label}</span>
      <Switch size="sm" checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

// A label + dropdown row. Options may carry an icon (rendered in both the value
// and the menu items); `fallbackLabel` covers the unreachable case of a value
// not present in `options`.
function SelectRow({
  label,
  value,
  onValueChange,
  options,
  width,
  fallbackLabel,
  contentClassName,
}: {
  label: string;
  value: string;
  onValueChange: (value: string | null) => void;
  options: readonly SelectRowOption[];
  width: string;
  fallbackLabel?: string;
  contentClassName?: string;
}) {
  return (
    <label className={settingsRowClass}>
      <span className={settingsLabelClass}>{label}</span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger size="sm" className={`${selectTriggerClass} ${width}`}>
          <SelectValue>
            {(current) => {
              const option = options.find((opt) => opt.id === current);
              if (!option) return fallbackLabel ?? options[0]?.label;
              const Icon = option.icon;
              return (
                <span className="flex items-center gap-2">
                  {Icon && <Icon size={13} />}
                  {option.label}
                </span>
              );
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="end" className={contentClassName}>
          <SelectGroup>
            {options.map((option) => {
              const Icon = option.icon;
              return (
                <SelectItem key={option.id} value={option.id} className={selectItemClass}>
                  {Icon && <Icon size={13} />}
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}

export function DiffSettingsPopover({
  open,
  onOpenChange,
  appColorScheme,
  onColorSchemeChange,
  diffStyle,
  onDiffStyleToggle,
  orderBy,
  orderDir,
  onOrderByChange,
  onOrderDirToggle,
  diffThemeId,
  onDiffThemeChange,
  selectedDiffThemeLabel,
  showBackground,
  setShowBackground,
  showLineNumbers,
  setShowLineNumbers,
  wordWrap,
  setWordWrap,
  collapseRemovals,
  setCollapseRemovals,
  hideReviewed,
  setHideReviewed,
  onShortcutsOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
}) {
  const renderToggles = [
    { label: "Line backgrounds", checked: showBackground, onChange: setShowBackground },
    { label: "Line numbers", checked: showLineNumbers, onChange: setShowLineNumbers },
    { label: "Word wrap", checked: wordWrap, onChange: setWordWrap },
    { label: "Collapse removals", checked: collapseRemovals, onChange: setCollapseRemovals },
  ];

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={headerIconButtonClass}
                  aria-label="Settings"
                >
                  <IconAdjustmentsHorizontal size={14} />
                </Button>
              }
            />
          }
        />
        <PopoverContent align="end" sideOffset={8} className={settingsPanelClass}>
          <div className="flex flex-col gap-1">
            <ToggleGroup
              variant="default"
              size="sm"
              spacing={0}
              value={[diffStyle]}
              onValueChange={(groupValue) => {
                const next = groupValue[0];
                if (next && next !== diffStyle) onDiffStyleToggle();
              }}
              aria-label="Diff view style"
              className="w-full rounded-[8px] bg-muted/50 p-0.5 dark:bg-white/[0.04]"
            >
              {diffStyleOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <ToggleGroupItem
                    key={option.id}
                    value={option.id}
                    className="h-11 flex-1 flex-col gap-1 rounded-[7px]! text-[12px] font-[450] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-neutral-800"
                    aria-label={`${option.label} view`}
                  >
                    <Icon size={16} />
                    {option.label}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
            <Separator className="my-1 opacity-60" />
            <div className={settingsGroupClass}>
              {renderToggles.map((toggle) => (
                <SwitchRow
                  key={toggle.label}
                  label={toggle.label}
                  checked={toggle.checked}
                  onCheckedChange={toggle.onChange}
                />
              ))}
            </div>
            <Separator className="my-1 opacity-60" />
            <div className={settingsGroupClass}>
              <div className={settingsRowClass}>
                <span className={settingsLabelClass}>Order by</span>
                <div className="flex items-center gap-1.5">
                  <Select
                    value={orderBy}
                    onValueChange={(value) => {
                      if (isDiffOrderBy(value)) onOrderByChange(value);
                    }}
                  >
                    <SelectTrigger size="sm" className={`${selectTriggerClass} w-[112px]`}>
                      <SelectValue>
                        {(value) =>
                          diffOrderByOptions.find((option) => option.id === value)?.label ?? "Path"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectGroup>
                        {diffOrderByOptions.map((option) => (
                          <SelectItem key={option.id} value={option.id} className={selectItemClass}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          className="size-7"
                          onClick={onOrderDirToggle}
                          aria-label={orderDir === "asc" ? "Sort descending" : "Sort ascending"}
                        >
                          {orderDir === "asc" ? (
                            <IconSortAscending size={14} />
                          ) : (
                            <IconSortDescending size={14} />
                          )}
                        </Button>
                      }
                    />
                    <TooltipContent>
                      {orderDir === "asc" ? "Sort descending" : "Sort ascending"}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <SwitchRow
                label="Hide reviewed"
                checked={hideReviewed}
                onCheckedChange={setHideReviewed}
              />
            </div>
            <Separator className="my-1 opacity-60" />
            <div className={settingsGroupClass}>
              <SelectRow
                label="Color scheme"
                value={appColorScheme}
                onValueChange={(value) => {
                  if (isAppColorScheme(value)) onColorSchemeChange(value);
                }}
                options={colorSchemeOptions}
                width="w-[140px]"
              />
              <SelectRow
                label="Diff theme"
                value={diffThemeId}
                onValueChange={(value) => {
                  if (isDiffThemeId(value)) onDiffThemeChange(value);
                }}
                options={diffThemeOptions}
                width="w-[140px]"
                fallbackLabel={selectedDiffThemeLabel}
                contentClassName="max-h-[260px]"
              />
            </div>
            <Separator className="my-1 opacity-60" />
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onShortcutsOpen();
              }}
              className={`${settingsRowClass} w-full cursor-pointer transition-colors hover:bg-muted/60 dark:hover:bg-white/[0.04]`}
            >
              <span className="flex items-center gap-2 text-muted-foreground">
                <IconKeyboard size={14} />
                Keyboard shortcuts
              </span>
              <Kbd>?</Kbd>
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <TooltipContent>Settings</TooltipContent>
    </Tooltip>
  );
}
