import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

export function PullRequestUrlForm({
  onNavigate,
  prUrl,
}: {
  onNavigate: (path: string) => void;
  prUrl: string;
}) {
  const [urlInput, setUrlInput] = useState(prUrl);

  function handleUrlSubmit(e: FormEvent) {
    e.preventDefault();
    const match = urlInput.match(/(?:https?:\/\/[^/]+\/)?([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (match) {
      const [, o, r, n] = match;
      onNavigate(`/${o}/${r}/pull/${n}`);
    }
  }

  return (
    <form className="group mr-auto flex min-w-0 flex-1 items-center gap-0.5" onSubmit={handleUrlSubmit}>
      <input
        value={urlInput}
        onChange={(e) => setUrlInput(e.target.value)}
        placeholder="https://github.com/org/repo/pull/123"
        className="block h-9 min-w-[24ch] max-w-[440px] flex-1 rounded-md bg-transparent px-2 text-[13px] text-neutral-500 outline-none focus:text-neutral-900 dark:focus:text-neutral-100"
      />
      {urlInput && (
        <button
          type="button"
          className={buttonVariants({
            variant: 'ghost',
            size: 'icon-sm',
            className: 'opacity-0 transition-opacity group-hover:opacity-50 group-focus-within:opacity-50 hover:!opacity-100',
          })}
          onClick={() => setUrlInput('')}
          aria-label="Clear"
        >
          <X size={14} />
        </button>
      )}
      <button type="submit" hidden />
    </form>
  );
}
