import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { Columns2, Rows2, Settings2 } from "lucide-react";
import { isAppColorScheme, type AppColorScheme } from "@/lib/colorScheme";
import type { DiffStyle, DiffThemeId } from "./types";
import {
  colorSchemeOptions,
  diffThemeOptions,
  headerIconButtonClass,
  isDiffThemeId,
} from "./helpers";

const settingsRowClass = "flex items-center justify-between gap-4 py-1.5 text-sm";

const diffStyleOptions = [
  { id: "split", label: "Split", icon: Columns2 },
  { id: "unified", label: "Unified", icon: Rows2 },
] as const satisfies readonly { id: DiffStyle; label: string; icon: typeof Columns2 }[];

export function DiffSettingsPopover({
  open,
  onOpenChange,
  appColorScheme,
  onColorSchemeChange,
  diffStyle,
  onDiffStyleToggle,
  diffThemeId,
  onDiffThemeChange,
  selectedDiffThemeLabel,
  showBackground,
  setShowBackground,
  showLineNumbers,
  setShowLineNumbers,
  wordWrap,
  setWordWrap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appColorScheme: AppColorScheme;
  onColorSchemeChange: (value: AppColorScheme) => void;
  diffStyle: DiffStyle;
  onDiffStyleToggle: () => void;
  diffThemeId: DiffThemeId;
  onDiffThemeChange: (value: DiffThemeId) => void;
  selectedDiffThemeLabel: string;
  showBackground: boolean;
  setShowBackground: (value: boolean) => void;
  showLineNumbers: boolean;
  setShowLineNumbers: (value: boolean) => void;
  wordWrap: boolean;
  setWordWrap: (value: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
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
            <Settings2 size={14} />
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={8} className="w-[300px] gap-3 p-3">
        <PopoverHeader>
          <PopoverTitle>Settings</PopoverTitle>
        </PopoverHeader>
        <div className="flex flex-col gap-1">
          <div className={settingsRowClass}>
            <span>View</span>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[diffStyle]}
              onValueChange={(groupValue) => {
                const next = groupValue[0];
                if (next && next !== diffStyle) onDiffStyleToggle();
              }}
              aria-label="Diff view style"
            >
              {diffStyleOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <ToggleGroupItem
                    key={option.id}
                    value={option.id}
                    className="h-7 px-2.5 text-xs"
                    aria-label={`${option.label} view`}
                  >
                    <Icon size={13} />
                    {option.label}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
          <label className={settingsRowClass}>
            <span>Line backgrounds</span>
            <Switch size="sm" checked={showBackground} onCheckedChange={setShowBackground} />
          </label>
          <label className={settingsRowClass}>
            <span>Line numbers</span>
            <Switch size="sm" checked={showLineNumbers} onCheckedChange={setShowLineNumbers} />
          </label>
          <label className={settingsRowClass}>
            <span>Word wrap</span>
            <Switch size="sm" checked={wordWrap} onCheckedChange={setWordWrap} />
          </label>
          <Separator className="my-1" />
          <label className={settingsRowClass}>
            <span>Color scheme</span>
            <Select
              value={appColorScheme}
              onValueChange={(value) => {
                if (isAppColorScheme(value)) onColorSchemeChange(value);
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-[134px] text-xs">
                <SelectValue>
                  {(value) => {
                    const option =
                      colorSchemeOptions.find((opt) => opt.id === value) ?? colorSchemeOptions[0];
                    const Icon = option.icon;
                    return (
                      <span className="flex items-center gap-2">
                        <Icon size={13} />
                        {option.label}
                      </span>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  {colorSchemeOptions.map((option) => {
                    const Icon = option.icon;
                    return (
                      <SelectItem key={option.id} value={option.id} className="text-xs">
                        <Icon size={13} />
                        {option.label}
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className={settingsRowClass}>
            <span>Diff theme</span>
            <Select
              value={diffThemeId}
              onValueChange={(value) => {
                if (isDiffThemeId(value)) onDiffThemeChange(value);
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-[134px] text-xs">
                <SelectValue>
                  {(value) =>
                    diffThemeOptions.find((option) => option.id === value)?.label ??
                    selectedDiffThemeLabel
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
        </div>
      </PopoverContent>
    </Popover>
  );
}
