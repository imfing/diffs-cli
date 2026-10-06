import { Link, useLocation } from "react-router";
import { useEffect, type ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";

function InfoPage({
  pageTitle,
  children,
  links,
  code,
  codeLabel,
}: {
  pageTitle: string;
  children: ReactNode;
  links: [to: string, label: string][];
  code: string;
  codeLabel: string;
}) {
  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  return (
    <main className="min-h-dvh bg-neutral-50 px-5 py-16 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
      <div className="mx-auto max-w-2xl">
        {children}
        <div className="mt-6 flex flex-wrap gap-2">
          {links.map(([to, label], i) => (
            <Link
              key={to}
              to={to}
              className={buttonVariants({ variant: i === 0 ? "default" : "outline", size: "lg" })}
            >
              {label}
            </Link>
          ))}
        </div>
        <pre
          className="mt-5 overflow-x-auto rounded-md border border-neutral-300 bg-white p-4 text-sm leading-6 text-neutral-800 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-none"
          aria-label={codeLabel}
        >
          {code}
        </pre>
      </div>
    </main>
  );
}

export function Home() {
  return (
    <InfoPage
      pageTitle="diffs"
      links={[
        ["/local", "Open Local Diff"],
        ["/org/repo/pull/123", "/org/repo/pull/123"],
      ]}
      codeLabel="CLI usage"
      code={`diffs
diffs --host localhost --port 4321 --dir /path/to/repo
diffs branch
diffs branch main
diffs pr
diffs pr 123
diffs pr org/repo/pull/123
diffs pr https://github.com/org/repo/pull/123
diffs pr --gh-host ghe.example.com /org/repo/pull/123`}
    >
      <h1 className="text-2xl font-semibold">diffs</h1>
    </InfoPage>
  );
}

export function NotFound() {
  const location = useLocation();
  return (
    <InfoPage
      pageTitle="Not found · diffs"
      links={[
        ["/", "Go home"],
        ["/local", "Open Local Diff"],
      ]}
      codeLabel="Available routes"
      code={`/
/local
/branch?base=<ref>[&head=<ref>]
/:org/:repo/pull/:number`}
    >
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
    </InfoPage>
  );
}
