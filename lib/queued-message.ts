// Wording for "saved here, queued for Spotify" responses, in the viewer's own time zone.
export function queuedMessage(what: string, until?: string | null): string {
  const t = until ? new Date(until) : null;
  const when = t && !isNaN(t.getTime())
    ? `${t.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : null;
  return `Saved in PaceSync, but Spotify is rate-limiting so ${what} is queued. ${when ? `The limit ends about ${when}; it will try again shortly after, automatically.` : "It will try again automatically when Spotify allows."}`;
}
