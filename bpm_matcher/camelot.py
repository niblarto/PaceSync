"""Camelot wheel key mapping and harmonic-mixing distance.

Spotify audio features report key as a pitch class (0=C .. 11=B, or -1 if no
key was detected) and mode as 1=major / 0=minor. DJs reason about harmonic
compatibility on the Camelot wheel instead, where adjacent numbers and
same-number major/minor pairs are considered compatible. Raw integer pitch
class distance doesn't capture that (e.g. C major and A minor are the same
notes but 9 semitones apart).
"""

# Spotify pitch class -> Camelot code
_MAJOR_CAMELOT = {
    0: "8B", 1: "3B", 2: "10B", 3: "5B", 4: "12B", 5: "7B",
    6: "2B", 7: "9B", 8: "4B", 9: "11B", 10: "6B", 11: "1B",
}
_MINOR_CAMELOT = {
    0: "5A", 1: "12A", 2: "7A", 3: "2A", 4: "9A", 5: "4A",
    6: "11A", 7: "6A", 8: "1A", 9: "8A", 10: "3A", 11: "10A",
}

# Max possible value from camelot_distance: 6 (opposite side of the wheel) * 2 + 1 (letter mismatch).
CAMELOT_MAX_DISTANCE = 13.0

# Distance assigned when one or both tracks have no detected key (Spotify key == -1).
# Deliberately mid-scale so missing key data neither favors nor penalizes a match.
CAMELOT_UNKNOWN_DISTANCE = 6.5


def to_camelot(key, mode) -> str | None:
    """Convert a Spotify (key, mode) pair to a Camelot code like '8B', or None if unknown."""
    if key is None or mode is None:
        return None
    key = int(key)
    if key < 0 or key > 11:
        return None
    table = _MAJOR_CAMELOT if int(mode) == 1 else _MINOR_CAMELOT
    return table[key]


def _parse(camelot: str) -> tuple[int, str]:
    return int(camelot[:-1]), camelot[-1].upper()


def camelot_distance(a: str | None, b: str | None) -> float:
    """Harmonic-mixing distance between two Camelot codes.

    0 = identical key. 1 = relative major/minor (same number, different letter).
    2 = adjacent number, same letter (a perfect fifth away - the classic DJ mix).
    Increases from there up to CAMELOT_MAX_DISTANCE for the least compatible pairing.
    """
    if a is None or b is None:
        return CAMELOT_UNKNOWN_DISTANCE
    na, la = _parse(a)
    nb, lb = _parse(b)
    diff = abs(na - nb)
    circular = min(diff, 12 - diff)
    return circular * 2 + (0 if la == lb else 1)
