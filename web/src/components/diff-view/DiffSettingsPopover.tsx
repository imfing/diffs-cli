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
import { useState, type ReactNode } from "react";
import { isAppColorScheme } from "@/lib/colorScheme";
import type { DiffSettingsProps, DiffStyle } from "./types";
import {
  colorSchemeOptions,
  diffOrderByOptions,
  diffThemeOptions,
  headerIconButtonClass,
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

function SelectRow({
  label,
  value,
  onValueChange,
  options,
  width,
  contentClassName,
  trailing,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectRowOption[];
  width: string;
  contentClassName?: string;
  trailing?: ReactNode;
}) {
  return (
    <label className={settingsRowClass}>
      <span className={settingsLabelClass}>{label}</span>
      <div className="flex items-center gap-1.5">
        <Select value={value} onValueChange={(next) => next != null && onValueChange(next)}>
          <SelectTrigger size="sm" className={`${selectTriggerClass} ${width}`}>
            <SelectValue>
              {(current) => {
                const option = options.find((opt) => opt.id === current) ?? options[0];
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
        {trailing}
      </div>
    </label>
  );
}

export function DiffSettingsPopover({
  settings,
  onSettingChange,
  appColorScheme,
  onColorSchemeChange,
  onShortcutsOpen,
}: DiffSettingsProps) {
  const [open, setOpen] = useState(false);
  const { diffStyle, orderBy, orderDir } = settings;
  const switches = [
    ["Line backgrounds", "lineBackgrounds"],
    ["Line numbers", "lineNumbers"],
    ["Word wrap", "wordWrap"],
    ["Collapse removals", "collapseRemovals"],
  ] as const;

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
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
                const next = groupValue[0] as DiffStyle | undefined;
                if (next && next !== diffStyle) onSettingChange("diffStyle", next);
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
              {switches.map(([label, name]) => (
                <SwitchRow
                  key={name}
                  label={label}
                  checked={settings[name]}
                  onCheckedChange={(value) => onSettingChange(name, value)}
                />
              ))}
            </div>
            <Separator className="my-1 opacity-60" />
            <div className={settingsGroupClass}>
              <SelectRow
                label="Order by"
                value={orderBy}
                onValueChange={(value) => onSettingChange("orderBy", value as typeof orderBy)}
                options={diffOrderByOptions}
                width="w-[112px]"
                trailing={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          className="size-7"
                          onClick={() =>
                            onSettingChange("orderDir", orderDir === "asc" ? "desc" : "asc")
                          }
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
                }
              />
              <SwitchRow
                label="Hide reviewed"
                checked={settings.hideReviewed}
                onCheckedChange={(value) => onSettingChange("hideReviewed", value)}
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
                value={settings.diffTheme}
                onValueChange={(value) =>
                  onSettingChange("diffTheme", value as typeof settings.diffTheme)
                }
                options={diffThemeOptions}
                width="w-[140px]"
                contentClassName="max-h-[260px]"
              />
            </div>
            <Separator className="my-1 opacity-60" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
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
