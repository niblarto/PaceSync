import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { randomUUID } from "crypto";
import { addTracksToLibrary } from "@/lib/library-add";
import { readAllTracks, regenerateCsvFile } from "@/lib/tracks-store";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { healActiveCsv } from "@/lib/csv-heal";
import { deezerIsrc, resolveByIsrc, sleep } from "@/lib/track-enrich";
import { getSpotifyBlockedUntil, setSpotifyBlockedUntil, SearchTokenSource } from "@/lib/spotify-rate-limit";
import { spotifySearchUri, isSpotifyRateLimited, stripBracketedSuffix } from "@/lib/spotify-search";
import { getDb } from "@/lib/db";

// Step 2 of Settings > Playlist Management's "Import tracks (title/artist/
// BPM/genre)" bulk import — the rows the user confirmed on the dedup review
// screen (app/api/tracks/import-lookup-csv/dedup) are written to the
// library as pending (URI-less, ISRC-keyed) tracks, then resolved to a real
// Spotify URI in two passes:
//
//   1. Deezer -> ISRC -> ReccoBeats (lib/track-enrich.ts, the same pipeline
//      lookup-list/route.ts already uses) — resolves BOTH the Spotify URI
//      AND a real tempo with no Spotify API call at all. Wherever this
//      succeeds, ReccoBeats' tempo REPLACES the CSV's own supplied BPM
//      (explicit product decision — online BPM always wins here, never the
//      pasted value), since it's measured directly from the actual audio
//      rather than whatever the user's source CSV claims.
//   2. Only for rows pass 1 couldn't resolve: Spotify Search, via the exact
//      same throttled/rate-limit-aware spotifySearchUri() csv-heal.ts's own
//      URI-search phase uses (secondary app first, sleep(400) between
//      calls, full 429 backoff/app-switch) — not a new throttle.
//
// Rows genuinely unresolved by both passes stay in the library as pending
// (isrc set if pass 1 found one but ReccoBeats had no tempo for it,
// otherwise still the placeholder) — the existing heal sweep's own `uris`
// phase will keep retrying them (by name+artist) on every future sweep,
// same as any other URI-less row already does.
//
// Each confirmed row is tagged with its own generated placeholder ISRC
// (`pending:<uuid>`) BEFORE writing, so this route can look its resulting
// DB row back up unambiguously afterward — addTracksToLibrary dedupes
// against the existing library and against itself by uri/isrc, so a
// rejected/deduped row simply never appears in the placeholder-keyed
// lookup below, rather than silently shifting every later row's index.

interface ConfirmRow { title: string; artist: string; bpm: number | null; genre: string | null }

const PLACEHOLDER_PREFIX = "pending:";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { rows } = await req.json() as { rows?: ConfirmRow[] };
  if (!rows?.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { /* stream closed */ }
      }, 15000);
      try {
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        // ── Write every confirmed row as a pending track first ──
        send({ type: "phase", phase: "writing", current: 0, total: rows.length });
        const placeholders = rows.map(() => `${PLACEHOLDER_PREFIX}${randomUUID()}`);
        const { added } = await addTracksToLibrary(
          rows.map((r, i) => ({
            name: r.title, artist: r.artist,
            tempo: r.bpm ?? undefined, genres: r.genre ?? undefined,
            isrc: placeholders[i],
          })),
        );
        send({ type: "log", text: `Added ${added} track${added === 1 ? "" : "s"} to the library (pending Spotify match)` });

        const csvFile = loadRunningPlaylistConfig().csvFile;
        const db = getDb();

        // ── Pass 1: Deezer -> ISRC -> ReccoBeats (no Spotify calls) ──
        let libraryRows = readAllTracks(csvFile);
        const placeholderSet = new Set(placeholders);
        const pendingRows = libraryRows.filter(t => t.isrc && placeholderSet.has(t.isrc));

        const setResolvedStmt = db.prepare(
          "UPDATE tracks SET uri = ?, isrc = ?, tempo = ? WHERE csv_file = ? AND row_no = ?",
        );
        const uriExistsStmt = db.prepare("SELECT 1 FROM tracks WHERE csv_file = ? AND uri = ?");

        let resolvedOnline = 0;
        let resolvedOnlineViaStrippedTitle = 0;
        let resolvedOnlineSkippedDupeUri = 0;
        send({ type: "phase", phase: "deezer", current: 0, total: pendingRows.length });
        for (let i = 0; i < pendingRows.length; i++) {
          const row = pendingRows[i];
          if (i > 0) await sleep(150);
          try {
            let isrc = await deezerIsrc(row.trackName ?? "", row.artistNames ?? "");
            let usedStrippedTitle = false;
            // Fall back to the title with any "(...)"/"[...]"/" - Suffix"
            // stripped — e.g. "New Way (Original Mix)" -> "New Way" — only
            // when the full title found nothing, and only if there WAS
            // something to strip (stripBracketedSuffix returns null
            // otherwise, so a bare title never gets searched twice).
            if (!isrc) {
              const stripped = stripBracketedSuffix(row.trackName ?? "");
              if (stripped) {
                await sleep(150);
                isrc = await deezerIsrc(stripped, row.artistNames ?? "");
                usedStrippedTitle = !!isrc;
              }
            }
            if (isrc) {
              await sleep(150);
              const resolved = await resolveByIsrc(isrc);
              if (resolved) {
                // Confirmed real bug: two DIFFERENT pending rows (e.g. a
                // bare title and its own "(X Remix)" row) can both resolve
                // to the same Spotify URI — the stripped-title fallback
                // above is the likely culprit for the bare-title case,
                // matching Deezer's own top result for a differently-
                // titled track. Writing that URI onto this row too would
                // create a silent duplicate-URI collision (two rows,
                // same uri, only one of which any future uri-keyed update
                // can unambiguously target) — skip and leave this row
                // pending instead, so the heal sweep's own uri phase (which
                // DOES check uniqueness via Spotify search) gets another
                // shot at it later.
                if (uriExistsStmt.get(csvFile, resolved.uri)) {
                  resolvedOnlineSkippedDupeUri++;
                } else {
                  setResolvedStmt.run(resolved.uri, isrc, resolved.tempo, csvFile, row.rowNo);
                  resolvedOnline++;
                  if (usedStrippedTitle) resolvedOnlineViaStrippedTitle++;
                }
              }
            }
          } catch { /* best-effort — this row falls through to the Spotify-search pass below */ }
          if ((i + 1) % 5 === 0 || i === pendingRows.length - 1) {
            send({ type: "phase", phase: "deezer", current: i + 1, total: pendingRows.length, resolved: resolvedOnline });
          }
        }
        send({
          type: "log",
          text: `Deezer/ReccoBeats resolved ${resolvedOnline} of ${pendingRows.length} tracks (BPM taken from ReccoBeats where matched)`
            + (resolvedOnlineViaStrippedTitle > 0 ? ` — ${resolvedOnlineViaStrippedTitle} matched only after stripping a bracketed suffix from the title` : "")
            + (resolvedOnlineSkippedDupeUri > 0 ? ` — ${resolvedOnlineSkippedDupeUri} skipped (would have duplicated a URI already in the library)` : ""),
        });

        // ── Pass 2: throttled Spotify search, only for what's left ──
        libraryRows = readAllTracks(csvFile);
        const stillPending = libraryRows.filter(t => t.isrc?.startsWith(PLACEHOLDER_PREFIX));
        let spotifyResolved = 0;
        let spotifyResolvedSkippedDupeUri = 0;
        if (stillPending.length > 0) {
          const blockedUntil = await getSpotifyBlockedUntil();
          const tokens = new SearchTokenSource(!!blockedUntil);
          send({ type: "phase", phase: "spotify", current: 0, total: stillPending.length });
          if (blockedUntil) {
            send({ type: "log", text: `Spotify still rate-limited from an earlier sweep — skipping Spotify search until ${new Date(blockedUntil).toLocaleTimeString()}` });
          } else {
            // spotifySearchUri already retries once with a bracketed/dash
            // suffix stripped from the title if the full-title search finds
            // nothing (lib/spotify-search.ts) — no separate fallback needed
            // here.
            const setUriStmt = db.prepare("UPDATE tracks SET uri = ?, isrc = NULL WHERE csv_file = ? AND row_no = ?");
            for (let i = 0; i < stillPending.length; i++) {
              const row = stillPending[i];
              const token = await tokens.current();
              if (!token) break;
              const result = await spotifySearchUri(row.trackName ?? "", row.artistNames ?? "", token);
              if (isSpotifyRateLimited(result)) {
                const hasAnotherApp = await tokens.onRateLimited();
                if (hasAnotherApp) { i--; continue; }
                await setSpotifyBlockedUntil(result.retryAt);
                send({ type: "log", text: `Spotify rate-limited — pausing, ${stillPending.length - i} tracks left unsearched this run` });
                break;
              }
              // Same duplicate-URI guard as the Deezer pass above — a
              // fuzzy/stripped-title Spotify search can also land on a
              // track already claimed by another row.
              if (result && uriExistsStmt.get(csvFile, result)) {
                spotifyResolvedSkippedDupeUri++;
              } else if (result) {
                setUriStmt.run(result, csvFile, row.rowNo);
                spotifyResolved++;
              }
              await sleep(400); // same conservative gap as csv-heal.ts's own uris phase
              if ((i + 1) % 5 === 0 || i === stillPending.length - 1) {
                send({ type: "phase", phase: "spotify", current: i + 1, total: stillPending.length, resolved: spotifyResolved });
              }
            }
          }
          send({
            type: "log",
            text: `Spotify search resolved ${spotifyResolved} of ${stillPending.length} remaining tracks`
              + (spotifyResolvedSkippedDupeUri > 0 ? ` — ${spotifyResolvedSkippedDupeUri} skipped (would have duplicated a URI already in the library)` : ""),
          });
        }

        await regenerateCsvFile(csvFile, activeCsvPath());
        void healActiveCsv().catch(() => {}); // fills any remaining duration/feature/genre gaps in the background

        send({
          type: "done",
          added, resolvedOnline, spotifyResolved,
          stillUnresolved: stillPending.length - spotifyResolved,
        });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Import failed" });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Content-Encoding": "none",
      "Connection": "keep-alive",
    },
  });
}
