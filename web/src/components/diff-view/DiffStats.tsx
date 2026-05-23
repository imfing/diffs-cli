import { useMemo } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";

export function DiffStats({
  files,
  pathCount,
}: {
  files: readonly FileDiffMetadata[];
  pathCount: number;
}) {
  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    let lines = 0;
    for (const f of files) {
      lines += f.unifiedLineCount;
      for (const h of f.hunks) {
        additions += h.additionLines;
        deletions += h.deletionLines;
      }
    }
    return { files: pathCount, additions, deletions, lines };
  }, [files, pathCount]);

  return (
    <div className="shrink-0 border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
      <div className="flex items-center justify-between py-0.5 text-xs">
        <span className="text-neutral-500">Files</span>
        <span className="font-mono tabular-nums font-semibold">{stats.files.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between border-t border-neutral-200/75 py-0.5 text-xs dark:border-neutral-700/75">
        <span className="text-neutral-500">Additions</span>
        <span className="font-mono tabular-nums font-semibold text-green-600 dark:text-green-400">
          +{stats.additions.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between border-t border-neutral-200/75 py-0.5 text-xs dark:border-neutral-700/75">
        <span className="text-neutral-500">Deletions</span>
        <span className="font-mono tabular-nums font-semibold text-red-600 dark:text-red-400">
          -{stats.deletions.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between border-t border-neutral-200/75 py-0.5 text-xs dark:border-neutral-700/75">
        <span className="text-neutral-500">Lines</span>
        <span className="font-mono tabular-nums font-semibold">{stats.lines.toLocaleString()}</span>
      </div>
    </div>
  );
}
