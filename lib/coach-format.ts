// Tidies coach output into the layout the Coach page and app render well:
// bold section headings on their own line, and one bullet per item.
// A safety net for when the model ignores the formatting instructions.

// "**Plan vs actual** — Fri 16: …" → "**Plan vs actual**" + "Fri 16: …"
const INLINE_HEADING = /^\s*(\*\*[^*\n]{2,60}\*\*)\s*[—–:-]\s*(\S.*)$/;

export function formatCoachText(text: string, opts: { splitHeadings?: boolean } = {}): string {
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    let line = raw;
    if (opts.splitHeadings) {
      const m = line.match(INLINE_HEADING);
      if (m) {
        out.push(m[1]);
        line = m[2];
      }
    }
    // Items joined with " | " (two or more) become one bullet each.
    const parts = line.split(/\s+\|\s+/).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 3 || (parts.length === 2 && !line.trim().startsWith("|"))) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      for (const p of parts) out.push(`${indent}- ${p.replace(/^[-*•]\s+/, "")}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
