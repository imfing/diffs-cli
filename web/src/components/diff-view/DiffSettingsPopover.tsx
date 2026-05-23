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
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { isAppColorScheme, type AppColorScheme } from "@/lib/colorScheme";
import type { DiffThemeId } from "./types";
import {
  colorSchemeOptions,
  diffThemeOptions,
  headerIconButtonClass,
  isDiffThemeId,
} from "./helpers";

const settingsRowClass = "flex items-center justify-between gap-4 py-1.5 text-sm";

export function DiffSettingsPopover({
  open,
  onOpenChange,
  appColorScheme,
  onColorSchemeChange,
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
                if (isAppColorScheme(value)) onColorSchemeChange(value);
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-[134px] text-xs">
                <SelectValue>
                  {(value) =>
                    colorSchemeOptions.find((option) => option.id === value)?.label ?? "System"
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
        </div>
      </PopoverContent>
    </Popover>
  );
}
