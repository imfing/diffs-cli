import { Link, useLocation } from "react-router";
import { useEffect } from "react";

export function NotFound() {
  const location = useLocation();

  useEffect(() => {
    document.title = "Not found · diffs";
  }, []);

  return (
    <main className="min-h-dvh bg-neutral-50 px-5 py-16 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
      <div className="mx-auto max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          404
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          No route matches{" "}
          <code className="rounded bg-neutral-200 px-1.5 py-0.5 font-mono text-[0.8125rem] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
            {location.pathname}
          </code>
          .
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            to="/"
            className="inline-flex h-9 items-center rounded-md bg-neutral-950 px-3.5 text-sm font-medium text-white no-underline outline-none transition-colors hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 dark:bg-neutral-50 dark:text-neutral-950 dark:hover:bg-neutral-200 dark:focus-visible:ring-offset-neutral-950"
          >
            Go home
          </Link>
          <Link
            to="/local"
            className="inline-flex h-9 items-center rounded-md border border-neutral-300 bg-white px-3.5 text-sm font-medium text-neutral-700 no-underline outline-none transition-colors hover:border-neutral-400 hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800 dark:focus-visible:ring-offset-neutral-950"
          >
            Open Local Diff
          </Link>
        </div>
        <pre
          className="mt-5 overflow-x-auto rounded-md border border-neutral-300 bg-white p-4 text-sm leading-6 text-neutral-800 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-none"
          aria-label="Available routes"
        >
          {`/
/local
/branch?base=<ref>
/:org/:repo/pull/:number`}
        </pre>
      </div>
    </main>
  );
}
