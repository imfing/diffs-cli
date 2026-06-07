import { useMemo, useState, useEffect, type CSSProperties } from "react";
import { useParams } from "react-router";
import { parsePatchFiles, type CodeViewItem, type FileDiffMetadata } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { apiFetch } from "@/lib/api";
import { DIFF_SURFACE_FONT_SIZE } from "@/lib/diffTypography";
import { fileBaseName, fileDirName } from "@/components/diff-view/helpers";
import { Markdown } from "./Markdown";
import { buildGuideGroups } from "./buildGuideGroups";

type Guide = {
  version: number;
  slug: string;
  title: string;
  branch?: string;
  base?: string;
  createdAt: string;
  updatedAt: string;
  steps: { id: string; title: string; body: string; files: string[] }[];
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; guide: Guide; patch: string | null };

const codeViewStyle = {
  flex: 1,
  overflow: "auto" as const,
  "--diffs-font-size": DIFF_SURFACE_FONT_SIZE,
} as CSSProperties;

const codeViewOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system" as const,
  diffStyle: "split" as const,
  stickyHeaders: true,
  layout: { paddingTop: 0, paddingBottom: 12, gap: 12 },
};

export function GuideView() {
  const { slug } = useParams<{ slug: string }>();

  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let ignore = false;

    const run = async () => {
      let fetchedGuide: Guide;
      try {
        fetchedGuide = await apiFetch<Guide>(`/api/guides/${slug}`);
      } catch (err) {
        if (!ignore) {
          setLoadState({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (ignore) return;

      const base = fetchedGuide.base ?? "";
      const patchEndpoint =
        base !== "" && !base.startsWith("pr:")
          ? `/api/branch-diff?base=${encodeURIComponent(base)}`
          : "/api/local-diff";

      let fetchedPatch: string | null = null;
      try {
        fetchedPatch = await apiFetch<string>(patchEndpoint);
      } catch {
        // patch failure is non-fatal; render with null patch
      }

      if (!ignore) {
        setLoadState({ status: "loaded", guide: fetchedGuide, patch: fetchedPatch });
      }
    };

    void run();

    return () => {
      ignore = true;
    };
  }, [slug]);

  const guide = loadState.status === "loaded" ? loadState.guide : null;
  const patch = loadState.status === "loaded" ? loadState.patch : null;

  const groups = useMemo(
    () => buildGuideGroups(patch, guide?.steps ?? []),
    [patch, guide],
  );

  // Clamp page to valid range when groups change
  const safePage = groups.length === 0 ? 0 : Math.min(page, groups.length - 1);
  const group = groups[safePage];

  const initialItems = useMemo<CodeViewItem[]>(() => {
    if (!group || !group.patch) return [];
    const parsed = parsePatchFiles(
      group.patch,
      `guide:${slug ?? ""}:${safePage}`,
    );
    const files: FileDiffMetadata[] = parsed.flatMap((p) => p.files);
    return files.map((f, i) => ({
      id: `diff:${f.name}:${i}`,
      type: "diff" as const,
      fileDiff: f,
    }));
  }, [group, slug, safePage]);

  if (loadState.status === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">
        Loading guide...
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">
        {loadState.error}
      </div>
    );
  }

  if (!guide || !group) {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">
        Guide not found.
      </div>
    );
  }

  const totalPages = groups.length;
  const isFirst = safePage === 0;
  const isLast = safePage === totalPages - 1;

  const pageLabel = `${String(safePage + 1).padStart(2, "0")} / ${String(totalPages).padStart(2, "0")}`;

  return (
    <div className="flex h-dvh text-xs">
      {/* Left column: sticky step sidebar */}
      <aside className="sticky top-0 flex h-dvh w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-700 dark:bg-neutral-900">
        {/* Guide title */}
        <div className="text-xs font-medium text-neutral-400 dark:text-neutral-500">
          {guide.title}
        </div>

        {/* Pager */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous step"
            disabled={isFirst}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="inline-flex size-7 items-center justify-center rounded border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <IconChevronLeft size={14} />
          </button>
          <span className="font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
            {pageLabel}
          </span>
          <button
            type="button"
            aria-label="Next step"
            disabled={isLast}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="inline-flex size-7 items-center justify-center rounded border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <IconChevronRight size={14} />
          </button>
        </div>

        {/* Step title */}
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {group.title}
        </h2>

        {/* Step body markdown */}
        {!group.isOther && group.body && (
          <div>
            <Markdown>{group.body}</Markdown>
          </div>
        )}

        {/* File list */}
        {group.files.length > 0 && (
          <div className="flex flex-col gap-1">
            {group.files.map((file) => (
              <div
                key={file.path}
                className="flex items-baseline gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 font-mono text-[11px] dark:border-neutral-700 dark:bg-neutral-800"
              >
                <span className="shrink-0 text-neutral-800 dark:text-neutral-200">
                  {fileBaseName(file.path)}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-400 dark:text-neutral-500">
                  {fileDirName(file.path)}
                </span>
                <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">
                  +{file.additions}
                </span>
                <span className="shrink-0 tabular-nums text-rose-600 dark:text-rose-400">
                  −{file.deletions}
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Right column: diff viewer */}
      <div className="flex min-w-0 flex-1">
        {group.patch ? (
          <CodeView
            key={`guide-page:${safePage}:${group.id}`}
            initialItems={initialItems}
            style={codeViewStyle}
            options={codeViewOptions}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-neutral-400 dark:text-neutral-600">
            No diff for this step.
          </div>
        )}
      </div>
    </div>
  );
}
