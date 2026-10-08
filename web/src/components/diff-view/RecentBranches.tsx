import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IconGitBranch } from "@tabler/icons-react";
import { apiFetch } from "@/lib/api";
import { branchDiffHref } from "./helpers";

const SHOW_LIMIT = 5;

// Shortcuts to compare other recently committed branches against `base`.
// Branches already on screen (the base and the current head) are skipped.
export function RecentBranches({ base, exclude }: { base: string; exclude: string[] }) {
  const [branches, setBranches] = useState<string[] | null>(null);
  // Stable dependency; callers pass a fresh array each render.
  const excludeKey = exclude.filter(Boolean).join("\0");

  useEffect(() => {
    let cancelled = false;
    const skip = new Set(excludeKey.split("\0"));
    // Ask for a few extra so the list stays full after exclusions.
    apiFetch<{ recent?: string[] }>(`/api/branches?recent=${SHOW_LIMIT + skip.size}`)
      .then((data) => {
        if (cancelled) return;
        const names = (data.recent ?? []).filter((name) => !skip.has(name));
        setBranches(names.slice(0, SHOW_LIMIT));
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base, excludeKey]);

  if (!branches?.length) return null;

  return (
    <div className="flex flex-col items-center gap-1.5 text-[12px]">
      <span className="text-muted-foreground">Recent branches</span>
      <ul className="flex flex-col items-center gap-1">
        {branches.map((name) => (
          <li key={name}>
            <Link
              to={branchDiffHref(base, name, false)}
              className="inline-flex items-center gap-1 text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
            >
              <IconGitBranch size={12} className="shrink-0 opacity-70" />
              <span className="truncate">{name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
