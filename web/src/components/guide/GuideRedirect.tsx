import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";
import { apiFetch } from "@/lib/api";
import type { Guide } from "./guideModel";

// Resolves a /guide/:slug URL to the integrated diff view with guide mode on.
// A guide bound to a branch base opens the branch diff; otherwise the local
// working-tree diff. The slug rides along as `?guide=` so DiffView activates it.
export function GuideRedirect() {
  const { slug } = useParams<{ slug: string }>();
  const [resolved, setResolved] = useState<{ target: string; guide: Guide } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let ignore = false;
    apiFetch<Guide>(`/api/guides/${encodeURIComponent(slug)}`)
      .then((guide) => {
        if (ignore) return;
        const base = guide.base ?? "";
        const q = `guide=${encodeURIComponent(slug)}`;
        setResolved({
          target:
            base !== "" && !base.startsWith("pr:")
              ? `/branch?base=${encodeURIComponent(base)}&${q}`
              : `/local?${q}`,
          guide,
        });
      })
      .catch(() => {
        if (!ignore) setFailed(true);
      });
    return () => {
      ignore = true;
    };
  }, [slug]);

  if (failed) return <Navigate to="/" replace />;
  if (!resolved) {
    return (
      <div className="flex h-dvh items-center justify-center text-neutral-500">Loading guide...</div>
    );
  }
  // Hand the already-fetched guide to DiffView via router state so it doesn't
  // refetch the same /api/guides/{slug} right after this redirect.
  return <Navigate to={resolved.target} replace state={{ guide: resolved.guide }} />;
}
