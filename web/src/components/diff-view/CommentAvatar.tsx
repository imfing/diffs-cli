function escapeSvgText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function avatarDataUri(author: string): string {
  const label = escapeSvgText(author.trim().slice(0, 1).toUpperCase() || "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="10" fill="#e5e5e5"/><text x="10" y="13" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="10" font-weight="600" fill="#525252">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function CommentAvatar({ author }: { author?: string }) {
  const name = author?.trim() || "Commenter";

  return (
    <img
      alt={name}
      className="size-5 shrink-0 rounded-full object-cover"
      src={avatarDataUri(name)}
    />
  );
}
