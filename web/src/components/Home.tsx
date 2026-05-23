import { Link } from "react-router";
import { useEffect } from "react";

export function Home() {
  useEffect(() => {
    document.title = "diffs";
  }, []);

  return (
    <main className="min-h-dvh bg-neutral-50 px-5 py-16 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">diffs</h1>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            to="/local"
            className="inline-flex h-9 items-center rounded-md bg-neutral-950 px-3.5 text-sm font-medium text-white no-underline outline-none transition-colors hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 dark:bg-neutral-50 dark:text-neutral-950 dark:hover:bg-neutral-200 dark:focus-visible:ring-offset-neutral-950"
          >
            Open Local Diff
          </Link>
          <Link
            to="/org/repo/pull/123"
            className="inline-flex h-9 items-center rounded-md border border-neutral-300 bg-white px-3.5 text-sm font-medium text-neutral-700 no-underline outline-none transition-colors hover:border-neutral-400 hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800 dark:focus-visible:ring-offset-neutral-950"
          >
            /org/repo/pull/123
          </Link>
        </div>
        <pre
          className="mt-5 overflow-x-auto rounded-md border border-neutral-300 bg-white p-4 text-sm leading-6 text-neutral-800 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-none"
          aria-label="CLI usage"
        >
          {`diffs
diffs local
diffs local --host localhost --port 4321 --dir /path/to/repo
diffs pr /org/repo/pull/123
diffs pr https://github.com/org/repo/pull/123
diffs pr --gh-host ghe.example.com /org/repo/pull/123`}
        </pre>
      </div>
    </main>
  );
}
