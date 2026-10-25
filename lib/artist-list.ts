// Song Crawler's Artist field: names separated by commas, where a name in
// double quotes keeps its own commas - `"Earth, Wind & Fire", The Levellers`
// is two artists. Pure (no server imports) so the page's autofill and the
// crawler share one parser.

const QUOTES = new Set(['"', "“", "”"]);

// Index of the last comma that isn't inside quotes, or -1.
function lastSeparator(text: string): number {
  let inQuote = false;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (QUOTES.has(c)) inQuote = !inQuote;
    else if (c === "," && !inQuote) last = i;
  }
  return last;
}

/** The artist names in the field: split on commas outside quotes, quotes removed. */
export function splitArtistList(text: string): string[] {
  const names: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const c of text) {
    if (QUOTES.has(c)) { inQuote = !inQuote; continue; }
    if (c === "," && !inQuote) { names.push(cur); cur = ""; continue; }
    cur += c;
  }
  names.push(cur);
  return names.map(n => n.trim()).filter(Boolean);
}

/** The name being typed (after the last unquoted comma) and everything before it. */
export function currentArtistSegment(text: string): { before: string; segment: string } {
  const cut = lastSeparator(text);
  return {
    before: cut >= 0 ? text.slice(0, cut + 1) + " " : "",
    segment: text.slice(cut + 1).replace(/^\s+/, "").replace(/^["“”]/, "").replace(/["“”]\s*$/, "").trim(),
  };
}

/** A name as written into the field: quoted if it has a comma of its own. */
export function formatArtistName(name: string): string {
  return name.includes(",") ? `"${name}"` : name;
}
