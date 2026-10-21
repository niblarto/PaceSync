// Rest-day mix markers — safe to import from client components (no server
// imports). A rest day's mix request carries these segment lines instead of
// pace segments; lib/ai-dj-mix.ts's buildAiDjMix spots REST_MIX_SEGMENT and
// builds the mix with lib/rest-day-mix.ts (no AI DJ involved).

export const REST_MIX_SEC = 2 * 60 * 60; // two hours
export const REST_MIX_SEGMENT = "Rest day — unplayed songs, oldest added first";

export function restDaySegments(): string[] {
  // The "•" header gives the mix its target length, like a run's summary line.
  return ["Rest • 2h - 2h", REST_MIX_SEGMENT];
}

export function isRestDaySegments(segments: string[] | undefined | null): boolean {
  return !!segments?.includes(REST_MIX_SEGMENT);
}
