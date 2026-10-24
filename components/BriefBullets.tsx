// Bullet list for the short summaries on the Runna cards: each line may start
// with a **bold** lead-in.
export function BriefBullets({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1.5">
      {lines.map((raw, i) => {
        const l = raw.replace(/^\s*[-•*]\s+/, "").trim();
        return (
          <li key={i} className="flex gap-2 text-[13px] leading-snug text-slate-200">
            <span className="text-slate-600">•</span>
            <span>
              {l.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
                part.startsWith("**") && part.endsWith("**")
                  ? <strong key={j} className="font-semibold text-slate-100">{part.slice(2, -2)}</strong>
                  : <span key={j}>{part}</span>)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
