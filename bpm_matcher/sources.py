"""Candidate discovery for Phase B: tracks NOT already in the playlist.

Spotify killed its recommendations/related-artists endpoints for new apps
(Nov 2024, no replacement), so discovery comes from:

- Last.fm track.getSimilar (best quality; needs a free API key from
  https://www.last.fm/api/account/create, read from LASTFM_API_KEY).
- Deezer related-artists top tracks (keyless fallback / supplement).

Deezer is also used to resolve any candidate's (artist, title) to an ISRC,
which ReccoBeats accepts as a track ID for audio features (see enrich.py).
"""

import os
import time
from dataclasses import dataclass, field

import requests

LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/"
DEEZER_API_URL = "https://api.deezer.com"

# Deezer allows 50 requests per 5 seconds; Last.fm asks for <=5/sec.
_REQUEST_DELAY = 0.15

_session = requests.Session()
_session.headers["User-Agent"] = "bpm-matcher/0.1 (playlist similarity tool)"


def _get(url: str, params: dict | None = None) -> dict:
    time.sleep(_REQUEST_DELAY)
    resp = _session.get(url, params=params, timeout=15)
    resp.raise_for_status()
    return resp.json()


@dataclass
class Candidate:
    artist: str
    title: str
    source: str  # e.g. "lastfm:<seed track>" or "deezer:<related artist>"
    isrc: str | None = None
    deezer_id: int | None = None
    match_score: float | None = None  # Last.fm similarity score if available
    extra: dict = field(default_factory=dict)

    def key(self) -> tuple[str, str]:
        """Normalized identity for dedupe against the playlist and other candidates."""
        return (_norm(self.artist), _norm(self.title))


def _norm(s: str) -> str:
    s = s.lower().strip()
    # Strip common version suffixes so "Song - 2011 Remaster" matches "Song".
    for sep in (" - ", " ("):
        if sep in s:
            s = s.split(sep)[0].strip()
    return s


def normalized_key(artist: str, title: str) -> tuple[str, str]:
    return (_norm(artist), _norm(title))


# ---------------------------------------------------------------- Last.fm

def lastfm_api_key() -> str | None:
    return os.environ.get("LASTFM_API_KEY")


def lastfm_similar_tracks(artist: str, title: str, api_key: str, limit: int = 20) -> list[Candidate]:
    """Candidates similar to one seed track, via Last.fm track.getSimilar."""
    data = _get(
        LASTFM_API_URL,
        params={
            "method": "track.getsimilar",
            "artist": artist,
            "track": title,
            "api_key": api_key,
            "format": "json",
            "autocorrect": 1,
            "limit": limit,
        },
    )
    tracks = data.get("similartracks", {}).get("track", [])
    return [
        Candidate(
            artist=t["artist"]["name"],
            title=t["name"],
            source=f"lastfm:{artist} - {title}",
            match_score=float(t.get("match", 0)),
        )
        for t in tracks
        if t.get("artist", {}).get("name") and t.get("name")
    ]


# ----------------------------------------------------------------- Deezer

def deezer_search_track(artist: str, title: str) -> Candidate | None:
    """Resolve (artist, title) to a Deezer track (and its ISRC)."""
    data = _get(
        f"{DEEZER_API_URL}/search",
        params={"q": f'artist:"{artist}" track:"{title}"', "limit": 1},
    )
    hits = data.get("data", [])
    if not hits:
        # Retry as a loose query; the fielded search misses some spellings.
        data = _get(f"{DEEZER_API_URL}/search", params={"q": f"{artist} {title}", "limit": 1})
        hits = data.get("data", [])
    if not hits:
        return None
    hit = hits[0]
    detail = _get(f"{DEEZER_API_URL}/track/{hit['id']}")
    return Candidate(
        artist=hit["artist"]["name"],
        title=hit["title"],
        source="deezer:search",
        isrc=detail.get("isrc") or None,
        deezer_id=hit["id"],
    )


def resolve_isrc(candidate: Candidate) -> Candidate:
    """Fill in candidate.isrc via Deezer search if missing. Returns the candidate."""
    if candidate.isrc:
        return candidate
    found = deezer_search_track(candidate.artist, candidate.title)
    if found:
        candidate.isrc = found.isrc
        candidate.deezer_id = found.deezer_id
    return candidate


def deezer_related_artist_tracks(artist: str, top_n_artists: int = 5, tracks_per_artist: int = 5) -> list[Candidate]:
    """Keyless discovery: top tracks of artists Deezer considers related to `artist`."""
    data = _get(f"{DEEZER_API_URL}/search/artist", params={"q": artist, "limit": 1})
    hits = data.get("data", [])
    if not hits:
        return []
    artist_id = hits[0]["id"]

    related = _get(f"{DEEZER_API_URL}/artist/{artist_id}/related").get("data", [])[:top_n_artists]
    candidates = []
    for rel in related:
        top = _get(f"{DEEZER_API_URL}/artist/{rel['id']}/top", params={"limit": tracks_per_artist})
        for t in top.get("data", []):
            candidates.append(
                Candidate(
                    artist=rel["name"],
                    title=t["title"],
                    source=f"deezer:{artist}->{rel['name']}",
                    deezer_id=t["id"],
                )
            )
    return candidates
