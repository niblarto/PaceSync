import { getSession } from "next-auth/react";

// Client-side Spotify calls must not trust the in-memory useSession() token:
// it goes stale if the tab stays open past the token's 1-hour expiry. Fetching
// the session runs next-auth's server-side JWT callback, which refreshes an
// expired Spotify token before handing it back.
export async function freshSpotifyToken(): Promise<string | null> {
  try {
    const s = await getSession();
    return s?.accessToken ?? null;
  } catch {
    return null;
  }
}
