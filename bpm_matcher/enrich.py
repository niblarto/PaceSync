"""Audio features for candidate tracks via ReccoBeats (free, keyless).

ReccoBeats was built to replace Spotify's dead audio-features endpoint and
accepts Spotify track IDs or ISRCs in its `ids` parameter. We feed it the
ISRCs resolved by Deezer and get back Spotify-style features plus a link to
the track on Spotify.
"""

import time

import pandas as pd
import requests

from .camelot import to_camelot
from .sources import Candidate

RECCOBEATS_API_URL = "https://api.reccobeats.com/v1"
_BATCH_SIZE = 40

_session = requests.Session()
_session.headers["User-Agent"] = "bpm-matcher/0.1 (playlist similarity tool)"


def _get_features_batch(ids: list[str]) -> list[dict]:
    resp = _session.get(
        f"{RECCOBEATS_API_URL}/audio-features",
        params={"ids": ",".join(ids)},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json().get("content", [])


def features_for_candidates(candidates: list[Candidate]) -> pd.DataFrame:
    """Fetch audio features for candidates that have an ISRC.

    Returns a DataFrame with the same feature columns Phase A uses
    (Tempo/Key/Mode/Energy/Danceability/Valence/Camelot) plus identity
    columns (Track Name, Artist Name(s), ISRC, Spotify URL, Source).
    Candidates ReccoBeats doesn't know are silently dropped.
    """
    with_isrc = [c for c in candidates if c.isrc]
    by_isrc = {c.isrc: c for c in with_isrc}

    rows = []
    isrcs = list(by_isrc)
    for i in range(0, len(isrcs), _BATCH_SIZE):
        batch = isrcs[i : i + _BATCH_SIZE]
        for feat in _get_features_batch(batch):
            cand = by_isrc.get(feat.get("isrc"))
            if cand is None or feat.get("tempo") is None:
                continue
            rows.append(
                {
                    "Track Name": cand.title,
                    "Artist Name(s)": cand.artist,
                    "ISRC": cand.isrc,
                    "Spotify URL": feat.get("href"),
                    "Source": cand.source,
                    "Tempo": float(feat["tempo"]),
                    "Key": int(feat.get("key", -1)),
                    "Mode": int(feat.get("mode", 0)),
                    "Energy": float(feat.get("energy", 0.5)),
                    "Danceability": float(feat.get("danceability", 0.5)),
                    "Valence": float(feat.get("valence", 0.5)),
                }
            )
        time.sleep(0.2)

    df = pd.DataFrame(rows)
    if not df.empty:
        df["Camelot"] = [to_camelot(k, m) for k, m in zip(df["Key"], df["Mode"])]
        df = df.drop_duplicates(subset="ISRC").reset_index(drop=True)
    return df
