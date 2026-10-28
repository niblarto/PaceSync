// Pick up anything still queued for Spotify (playlist saves, track removals) after a restart, without waiting
// for someone to open a page that happens to touch the queue.
import { ensureOutboxStarted } from "@/lib/spotify-outbox";
import { ensureSpotifyRemovalsStarted } from "@/lib/spotify-removals";

ensureOutboxStarted();
ensureSpotifyRemovalsStarted();
