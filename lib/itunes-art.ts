const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
const queue: Array<() => void> = [];
let running = 0;
const MAX_CONCURRENT = 4;

function scheduleNext() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    running++;
    queue.shift()!();
  }
}

export function fetchItunesArt(artist: string, title: string): Promise<string | null> {
  const key = `${title}|||${artist}`.toLowerCase();
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  if (pending.has(key)) return pending.get(key)!;

  const p = new Promise<string | null>(resolve => {
    queue.push(async () => {
      try {
        const params = new URLSearchParams({ artist, title });
        const res = await fetch(`/api/itunes-art?${params}`);
        if (!res.ok) { cache.set(key, null); resolve(null); return; }
        const data = await res.json() as { url: string | null };
        cache.set(key, data.url);
        resolve(data.url);
      } catch {
        cache.set(key, null);
        resolve(null);
      } finally {
        running--;
        pending.delete(key);
        scheduleNext();
      }
    });
    scheduleNext();
  });

  pending.set(key, p);
  return p;
}
