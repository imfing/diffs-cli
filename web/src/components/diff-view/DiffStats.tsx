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

  const rows = [
    ["Files", stats.files.toLocaleString(), ""],
    ["Additions", `+${stats.additions.toLocaleString()}`, "text-green-600 dark:text-green-400"],
    ["Deletions", `-${stats.deletions.toLocaleString()}`, "text-red-600 dark:text-red-400"],
    ["Lines", stats.lines.toLocaleString(), ""],
  ];

  return (
    <div className="shrink-0 border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
      {rows.map(([label, value, color], i) => (
        <div
          key={label}
          className={`flex items-center justify-between py-0.5 text-xs${i > 0 ? " border-t border-neutral-200/75 dark:border-neutral-700/75" : ""}`}
        >
          <span className="text-neutral-500">{label}</span>
          <span className={`font-mono tabular-nums font-semibold ${color}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}
