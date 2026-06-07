import type { FileDiffMetadata } from "@pierre/diffs";

// Full guide as returned by GET /api/guides/{slug}.
export type Guide = {
  version: number;
  slug: string;
  title: string;
  branch?: string;
  base?: string;
  createdAt: string;
  updatedAt: string;
  steps: GuideStep[];
};

export type GuideStep = {
  id: string;
  title: string;
  body: string;
  files: string[];
};

// Summary row from GET /api/guides (no per-step detail).
export type GuideSummary = {
  slug: string;
  title: string;
  branch?: string;
  base?: string;
  createdAt: string;
  updatedAt: string;
  steps: number;
  files: number;
};

// One step as rendered in the guide sidebar: its prose plus the parsed diffs of
// the files it claims, in step order. `isOther` marks the synthetic pool of
// files no step claimed.
export type GuideDisplayStep = {
  id: string;
  title: string;
  body: string;
  files: FileDiffMetadata[];
  isOther: boolean;
};

export type GuideOrdering = {
  // Files reordered so each step's files appear together in step order, with the
  // unclaimed "Other changes" pool last. Drives the CodeView item order.
  files: FileDiffMetadata[];
  // Maps a file path to the display-step index whose panel should show while
  // that file is at the top of the viewport.
  fileToStep: Map<string, number>;
  displaySteps: GuideDisplayStep[];
};

const OTHER_TITLE = "Other changes";

// Arranges the diff's files into the guide's steps. A file is claimed by the
// first step that lists it; files no step claims fall into a trailing "Other
// changes" step. Steps referencing files absent from the current diff simply
// render with fewer (or no) files — stale references never break the layout.
export function orderFilesByGuide(
  files: readonly FileDiffMetadata[],
  steps: readonly GuideStep[],
): GuideOrdering {
  const byName = new Map<string, FileDiffMetadata>();
  for (const f of files) if (!byName.has(f.name)) byName.set(f.name, f);

  const ordered: FileDiffMetadata[] = [];
  const fileToStep = new Map<string, number>();
  const covered = new Set<string>();
  const displaySteps: GuideDisplayStep[] = [];

  steps.forEach((step, idx) => {
    const stepFiles: FileDiffMetadata[] = [];
    for (const path of step.files) {
      const file = byName.get(path);
      if (file == null || covered.has(path)) continue;
      covered.add(path);
      ordered.push(file);
      fileToStep.set(path, idx);
      stepFiles.push(file);
    }
    displaySteps.push({
      id: step.id,
      title: step.title,
      body: step.body,
      files: stepFiles,
      isOther: false,
    });
  });

  const otherFiles: FileDiffMetadata[] = [];
  const otherIdx = displaySteps.length;
  for (const file of files) {
    if (covered.has(file.name)) continue;
    ordered.push(file);
    fileToStep.set(file.name, otherIdx);
    otherFiles.push(file);
  }
  if (otherFiles.length > 0) {
    displaySteps.push({
      id: "__other__",
      title: OTHER_TITLE,
      body: "",
      files: otherFiles,
      isOther: true,
    });
  }

  return { files: ordered, fileToStep, displaySteps };
}
