import { useEffect, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";

export function CommentInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const tryEmit = () => {
    const trimmed = body.trim();
    if (trimmed) onSubmit(trimmed);
  };

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      tryEmit();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    tryEmit();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="group/input relative m-2 ml-3 flex max-w-[600px] flex-col gap-2.5 rounded-xl border border-[rgb(0_0_0_/_0.1)] bg-white bg-clip-padding p-3 font-sans shadow-[0_2px_4px_rgb(0_0_0_/_0.025),0_4px_8px_rgb(0_0_0_/_0.025)] dark:border-[rgb(255_255_255_/_0.1)] dark:bg-neutral-900/80 dark:shadow-[0_2px_4px_rgb(0_0_0_/_0.25),0_4px_8px_rgb(0_0_0_/_0.25)] md:flex-row"
    >
      <button
        type="button"
        onClick={onCancel}
        className="absolute -right-2 -top-2 flex size-5 cursor-pointer items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-400 opacity-0 shadow-sm transition-all hover:border-neutral-300 hover:text-neutral-600 group-hover/input:opacity-100 dark:border-neutral-600 dark:bg-neutral-800 dark:hover:border-neutral-500 dark:hover:text-neutral-200"
        title="Cancel"
      >
        <X size={12} />
      </button>
      <div className="flex w-full gap-2.5">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment…"
          rows={2}
          className="w-full resize-none rounded-sm bg-transparent py-1.5 text-[14px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-500 [field-sizing:content]"
        />
        <button
          type="submit"
          disabled={!body.trim()}
          className="inline-flex size-8 shrink-0 cursor-pointer select-none items-center justify-center self-end rounded-full bg-blue-500 text-white transition-all hover:bg-blue-600 disabled:pointer-events-none disabled:opacity-50"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </form>
  );
}
