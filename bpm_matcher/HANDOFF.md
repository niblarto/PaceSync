# Handoff: integrating AI_BPM into the Running website

*Written 2026-07-02 for the Claude session working in `E:\Code\Running`. The
matcher lives in `E:\Code\AI_BPM` and is complete and verified standalone —
this doc tells you what it does, how to call it, and what to watch out for
when wiring it into the site.*

## What AI_BPM is

A BPM/similarity matcher for Spotify playlists, driven off Exportify CSV
exports (the user exports playlists at exportify.net; a real export lives at
`E:\Code\AI_BPM\data\Running.csv`, and `E:\Code\Running\Running.csv` appears
to be another copy — verify freshness before relying on it).

Two capabilities, both proven against the user's real ~470-track playlist:

**Phase A — match within the playlist** (offline, instant, no network):
- `similar`: rank playlist tracks by weighted distance to a chosen track.
  Weights: BPM 0.5 (with half/double-time reconciliation, 174 ≈ 87),
  Camelot-wheel key distance 0.2 (true harmonic distance, not raw pitch
  class), energy/danceability/valence 0.1 each.
- `bpm`: direct filter, target ± tolerance, half/double-time aware.

**Phase B — suggest new tracks not in the playlist** (network, slow):
- Last.fm `track.getSimilar` per seed → Deezer search resolves each
  candidate (artist, title) → ISRC → ReccoBeats returns Spotify-style audio
  features + a Spotify URL for that ISRC → same Phase A distance ranks
  candidates against the seeds. Dedupes against the playlist by normalized
  artist/title (ignores " - Remaster"-style suffixes).

## How to call it

CLI (see `python -m bpm_matcher.cli --help`), or programmatically:

```python
from bpm_matcher import load_playlist, pairwise_distance_matrix, find_similar, bpm_filter
from bpm_matcher.suggest import suggest_tracks

df = load_playlist("Running.csv")           # validates columns, adds Camelot
dist = pairwise_distance_matrix(df)          # (n, n) numpy array
matches = find_similar(df, dist, track_index=0, n=10)   # list of Match dataclasses
around_174 = bpm_filter(df, 174, tolerance=3)            # DataFrame with bpm_diff col

seeds = df.sample(5)                         # or df rows matching a chosen track
suggestions = suggest_tracks(df, seeds, n=20)  # DataFrame: Track Name, Artist Name(s),
                                               # Tempo, Camelot, Spotify URL, distance,
                                               # closest_seed
```

Dependencies: pandas, numpy, scikit-learn, requests (`requirements.txt`).
Tests: `pytest` in the repo root, 18 tests, all passing. There is a venv at
`E:\Code\AI_BPM\.venv` (Windows). Suggested integration route: install
`bpm_matcher` into the site's environment (add AI_BPM to path, vendor the
package, or `pip install -e E:\Code\AI_BPM` — no pyproject.toml exists yet,
so you may want to add one first).

## Hard-won API knowledge (do not rediscover)

- **Spotify's recommendations/audio-features/related-artists are dead** for
  new apps (Nov 2024, still no replacement mid-2026). Nothing here uses the
  Spotify API at all.
- **ReccoBeats** (free, keyless, `api.reccobeats.com/v1`) accepts **ISRCs or
  Spotify track IDs** interchangeably in `GET /v1/audio-features?ids=...`
  (batch ≤40) and returns Spotify-style features + `href` (Spotify URL). The
  ISRC acceptance is undocumented but verified working — it's the bridge
  that makes keyless enrichment possible.
- **Deezer** (free, keyless): `search?q=artist:"X" track:"Y"` → track id;
  `/track/{id}` → ISRC. Rate limit 50 req/5s; code sleeps 0.15s between
  calls.
- **Last.fm**: key is in the `LASTFM_API_KEY` user env var (set via setx
  2026-07-02; new shells only). App "Running BPM Suggestions", registered to
  niblarto. Without the key, discovery falls back to keyless Deezer
  related-artists — works but finds far fewer new tracks. The Last.fm shared
  secret is unused and unneeded.
- ReccoBeats' own `/track/recommendation` endpoint was evaluated and
  produces near-random results — deliberately not used.
- **Rejected approach, don't redo**: sentence-transformer embeddings +
  FAISS-GPU (no Windows wheels, overkill at playlist scale, text embeddings
  don't preserve numeric proximity).

## Integration cautions

- **`suggest_tracks` is slow** (roughly 1–2 min for 5 seeds: ~2 sequential
  Deezer calls per candidate plus polite sleeps). Do NOT call it inline in a
  web request on the Pi — run it as a background job / cron and cache
  results (it's deterministic enough per seed set to cache aggressively).
  Phase A calls are instant and fine inline.
- Expect **~40% candidate drop-out** through the Deezer→ReccoBeats chain
  (measured: 42 discovered → 35 ISRCs → 25 with features). Over-fetch
  accordingly (`per_seed`, `max_candidates` params).
- Progress/diagnostics from `suggest_tracks` go to **stderr** via `_log()`.
- `load_playlist` drops rows with missing Tempo and requires the Exportify
  column set (Track Name, Artist Name(s), Tempo, Key, Mode, Energy,
  Danceability, Valence).
- On the Pi: everything is portable (pure Python, aarch64/piwheels wheels
  exist). Put `LASTFM_API_KEY` in the site's systemd unit or `.env`.
  Optional: scikit-learn is only used for `NearestNeighbors` over a
  precomputed matrix and can be replaced with `np.argsort` in a few lines if
  install weight matters — the user has deferred this ("not yet").

## Repo map

```
bpm_matcher/
  camelot.py    # Spotify (key, mode) -> Camelot code + harmonic distance
  features.py   # Exportify CSV loading/validation
  match.py      # weighted distance matrices (pairwise + cross), find_similar, bpm_filter
  sources.py    # Last.fm + Deezer discovery, ISRC resolution, Candidate dataclass
  enrich.py     # ReccoBeats audio features by ISRC (batched)
  suggest.py    # Phase B orchestration: discover -> dedupe -> resolve -> enrich -> rank
  cli.py        # subcommands: similar, bpm, suggest
tests/          # 18 tests incl. mocked-API tests for Phase B
data/Running.csv  # real playlist export (2026-06-28 vintage)
```
