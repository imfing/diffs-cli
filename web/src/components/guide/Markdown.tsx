import ReactMarkdown from "react-markdown";

interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="prose-guide text-sm text-neutral-700 dark:text-neutral-300 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-neutral-900 [&_h1]:first:mt-0 dark:[&_h1]:text-neutral-100 [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-neutral-900 [&_h2]:first:mt-0 dark:[&_h2]:text-neutral-100 [&_h3]:mb-1 [&_h3]:mt-2.5 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-neutral-800 dark:[&_h3]:text-neutral-200 [&_p]:mb-2 [&_p]:leading-relaxed [&_p:last-child]:mb-0 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-0.5 [&_li]:leading-relaxed [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-neutral-800 dark:[&_code]:bg-neutral-800 dark:[&_code]:text-neutral-200 [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-neutral-100 [&_pre]:p-3 dark:[&_pre]:bg-neutral-800 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-blue-600 [&_a]:underline [&_a]:underline-offset-2 [&_a]:hover:text-blue-700 dark:[&_a]:text-blue-400 dark:[&_a]:hover:text-blue-300 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-500 dark:[&_blockquote]:border-neutral-600 dark:[&_blockquote]:text-neutral-400 [&_hr]:my-3 [&_hr]:border-neutral-200 dark:[&_hr]:border-neutral-700">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
