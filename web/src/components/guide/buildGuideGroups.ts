import { splitPatchByFile } from "@/components/diff-view/helpers";

export type GuideFile = {
  path: string;
  additions: number;
  deletions: number;
};

export type GuideGroup = {
  id: string;
  title: string;
  body: string;
  files: GuideFile[];
  patch: string;
  isOther: boolean;
};

// Counts added/removed lines in a single file's unified-diff section, ignoring
// the `+++`/`---` file headers and `@@` hunk headers.
function countChanges(filePatch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of filePatch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

type Step = {
  id: string;
  title: string;
  body: string;
  files: string[];
};

export function buildGuideGroups(patch: string | null, steps: Step[]): GuideGroup[] {
  const sections = splitPatchByFile(patch);

  const covered = new Set<string>();
  const groups: GuideGroup[] = [];

  for (const step of steps) {
    const stepPatchParts: string[] = [];
    const stepFiles: GuideFile[] = [];
    for (const filePath of step.files) {
      const filePatch = sections.get(filePath);
      if (filePatch != null) {
        stepPatchParts.push(filePatch);
        covered.add(filePath);
        stepFiles.push({ path: filePath, ...countChanges(filePatch) });
      } else {
        // File no longer in the diff (stale reference); show it with no stats.
        stepFiles.push({ path: filePath, additions: 0, deletions: 0 });
      }
    }

    groups.push({
      id: step.id,
      title: step.title,
      body: step.body,
      files: stepFiles,
      patch: stepPatchParts.join(""),
      isOther: false,
    });
  }

  // Collect uncovered files in Map insertion order
  const uncoveredFiles: GuideFile[] = [];
  const uncoveredPatchParts: string[] = [];
  for (const [filePath, filePatch] of sections) {
    if (!covered.has(filePath)) {
      uncoveredFiles.push({ path: filePath, ...countChanges(filePatch) });
      uncoveredPatchParts.push(filePatch);
    }
  }

  if (uncoveredFiles.length > 0) {
    groups.push({
      id: "__other__",
      title: "Other changes",
      body: "",
      files: uncoveredFiles,
      patch: uncoveredPatchParts.join(""),
      isOther: true,
    });
  }

  // If there are no steps at all and no uncovered files either (empty patch),
  // return an empty array — nothing to show.
  // But if steps is empty and there ARE uncovered files, we already appended
  // the Other bucket above.

  return groups;
}
