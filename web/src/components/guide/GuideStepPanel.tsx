import { fileBaseName, fileDirName } from "@/components/diff-view/helpers";
import { Markdown } from "./Markdown";
import type { GuideDisplayStep } from "./guideModel";

// The guide sidebar. Shows the whole current step pinned, filling the column
// height. One step maps to several diffs on the right, so the panel stays put
// while those diffs scroll past and only swaps when the diff crosses into the
// next step — the incoming step slides up from the bottom rather than cutting in.
export function GuideStepPanel({
  steps,
  current,
  onSelectFile,
}: {
  steps: GuideDisplayStep[];
  current: number;
  onSelectFile: (path: string) => void;
}) {
  const step = steps[current];
  if (!step) return null;

  const total = steps.length;
  const counter = `${String(current + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      <span className="font-mono text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
        {counter}
      </span>

      {/* Keyed by step so the incoming step remounts and replays the slide-in. */}
      <div
        key={current}
        className="flex flex-col gap-4 duration-300 ease-out animate-in fade-in slide-in-from-bottom-4"
      >
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {step.title}
        </h2>

        {!step.isOther && step.body && (
          <div>
            <Markdown>{step.body}</Markdown>
          </div>
        )}

        {step.files.length > 0 && (
          <div className="flex flex-col gap-1">
            {step.files.map((file) => (
              <button
                key={file.name}
                type="button"
                onClick={() => onSelectFile(file.name)}
                className="flex items-baseline gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:border-neutral-600 dark:hover:bg-neutral-700"
              >
                <span className="shrink-0 text-neutral-800 dark:text-neutral-200">
                  {fileBaseName(file.name)}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-400 dark:text-neutral-500">
                  {fileDirName(file.name)}
                </span>
                <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">
                  +{file.additionLines.length}
                </span>
                <span className="shrink-0 tabular-nums text-rose-600 dark:text-rose-400">
                  −{file.deletionLines.length}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
