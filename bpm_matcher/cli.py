"""Command-line entry point: find similar tracks or filter by BPM within an
Exportify-exported playlist CSV.
"""

import argparse
import sys

from .features import load_playlist
from .match import bpm_filter, find_similar, pairwise_distance_matrix


def _format_track(row) -> str:
    camelot = row["Camelot"] or "?"
    return f"{row['Track Name']} — {row['Artist Name(s)']} ({row['Tempo']:.1f} BPM, {camelot})"


def main():
    # Windows consoles often default to cp1252, which can't print many
    # track/artist names (Röyksopp, curly quotes, ...).
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Match tracks within an Exportify playlist CSV by BPM/key/feel.")
    parser.add_argument("csv_path", help="Path to an Exportify-exported playlist CSV.")
    sub = parser.add_subparsers(dest="command", required=True)

    similar = sub.add_parser("similar", help="Find tracks most similar to a given track.")
    similar.add_argument("track", help="Track name substring to search for (case-insensitive).")
    similar.add_argument("-n", type=int, default=10, help="Number of matches to return.")

    bpm = sub.add_parser("bpm", help="Filter tracks by target BPM (with half/double-time matching).")
    bpm.add_argument("target_bpm", type=float)
    bpm.add_argument("--tolerance", type=float, default=5.0, help="+/- BPM tolerance.")
    bpm.add_argument("--no-half-double", action="store_true", help="Disable half/double-time matching.")

    suggest = sub.add_parser("suggest", help="Suggest NEW tracks (not in the playlist) that fit it.")
    suggest.add_argument("--seed", help="Track name substring to seed from; omit to seed from random playlist tracks.")
    suggest.add_argument("--seeds", type=int, default=5, help="Number of random seed tracks when --seed is omitted.")
    suggest.add_argument("-n", type=int, default=20, help="Number of suggestions to return.")
    suggest.add_argument("--per-seed", type=int, default=20, help="Candidates to pull per seed track.")
    suggest.add_argument("--max-candidates", type=int, default=120, help="Cap on candidates to resolve/enrich.")
    suggest.add_argument("--deezer-related", action="store_true", help="Also mine Deezer related-artist top tracks.")
    suggest.add_argument("--no-lastfm", action="store_true", help="Skip Last.fm even if LASTFM_API_KEY is set.")

    args = parser.parse_args()
    df = load_playlist(args.csv_path)

    if args.command == "similar":
        matches = df[df["Track Name"].str.contains(args.track, case=False, na=False)]
        if matches.empty:
            print(f"No track found matching '{args.track}'")
            return
        idx = matches.index[0]
        print(f"Tracks similar to: {_format_track(df.loc[idx])}\n")

        dist_matrix = pairwise_distance_matrix(df)
        for m in find_similar(df, dist_matrix, idx, n=args.n):
            print(f"  {m.distance:.3f}  {_format_track(df.iloc[m.index])}")

    elif args.command == "bpm":
        result = bpm_filter(
            df,
            args.target_bpm,
            tolerance=args.tolerance,
            half_double_time=not args.no_half_double,
        )
        if result.empty:
            print(f"No tracks within {args.tolerance} BPM of {args.target_bpm}")
            return
        for _, row in result.iterrows():
            print(f"  +/-{row['bpm_diff']:.1f}  {_format_track(row)}")

    elif args.command == "suggest":
        from .suggest import suggest_tracks

        if args.seed:
            seeds = df[df["Track Name"].str.contains(args.seed, case=False, na=False)]
            if seeds.empty:
                print(f"No track found matching '{args.seed}'")
                return
        else:
            seeds = df.sample(min(args.seeds, len(df)))
        print("Seeding from:")
        for _, row in seeds.iterrows():
            print(f"  {_format_track(row)}")
        print()

        result = suggest_tracks(
            df,
            seeds,
            n=args.n,
            per_seed=args.per_seed,
            max_candidates=args.max_candidates,
            use_lastfm=not args.no_lastfm,
            use_deezer_related=args.deezer_related,
        )
        if result.empty:
            print("No suggestions found (no candidates survived ISRC/feature lookup).")
            return
        print(f"Suggested new tracks (best fit first):")
        for _, row in result.iterrows():
            camelot = row["Camelot"] or "?"
            print(
                f"  {row['distance']:.3f}  {row['Track Name']} — {row['Artist Name(s)']}"
                f" ({row['Tempo']:.1f} BPM, {camelot})  [near: {row['closest_seed']}]"
            )
            print(f"         {row['Spotify URL']}")


if __name__ == "__main__":
    main()
