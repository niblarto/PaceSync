import SpotifyProvider from "next-auth/providers/spotify";
import type { NextAuthOptions } from "next-auth";
import { saveTokens } from "./tokenStore";

const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-read-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-modify-playback-state",
].join(" ");

export const authOptions: NextAuthOptions = {
  providers: [
    SpotifyProvider({
      clientId: process.env.SPOTIFY_CLIENT_ID!,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
      authorization: { params: { scope: SPOTIFY_SCOPES, show_dialog: true } },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile, user }) {
      if (account && profile) {
        saveTokens({
          accessToken: account.access_token!,
          refreshToken: account.refresh_token!,
          expiresAt: account.expires_at!,
        });
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          userId: (profile as { id?: string }).id,
          scope: account.scope,
          // A custom jwt callback fully replaces `token` — NextAuth doesn't
          // auto-merge the OAuth profile's picture/name in for us, so pull
          // them from `user` explicitly (the adapter-mapped profile,
          // already has Spotify's images[0].url as `image` via the
          // provider's own profile() mapping) or the raw profile as fallback.
          picture: user?.image ?? (profile as { images?: { url?: string }[] }).images?.[0]?.url,
          name: user?.name ?? token.name,
        };
      }

      if (token.expiresAt && Date.now() < token.expiresAt * 1000 - 60_000) {
        return token;
      }

      const refreshed = await refreshSpotifyToken(token);
      const r = refreshed as Record<string, unknown>;
      if (r.accessToken && r.refreshToken && r.expiresAt) {
        saveTokens({
          accessToken: r.accessToken as string,
          refreshToken: r.refreshToken as string,
          expiresAt: r.expiresAt as number,
        });
      }
      return refreshed;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.error = token.error;
      session.scope = token.scope;
      if (token.userId) session.user.id = token.userId;
      // Explicit, not relied on as an automatic default — a custom jwt
      // callback means NextAuth won't reliably merge these in on its own.
      if (token.picture) session.user.image = token.picture as string;
      if (token.name) session.user.name = token.name;
      return session;
    },
  },
  pages: { signIn: "/" },
};

async function refreshSpotifyToken(token: {
  refreshToken?: string;
  [key: string]: unknown;
}) {
  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken ?? "",
    });

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64")}`,
      },
      body: params,
    });

    const data = await response.json();
    if (!response.ok) throw data;

    return {
      ...token,
      accessToken: data.access_token as string,
      expiresAt: Math.floor(Date.now() / 1000 + (data.expires_in as number)),
      refreshToken: (data.refresh_token as string | undefined) ?? token.refreshToken,
    };
  } catch {
    return { ...token, error: "RefreshAccessTokenError" };
  }
}
