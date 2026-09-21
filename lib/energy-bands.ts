// Low/Medium/High energy bands for the replace-by-BPM (♻) pickers' optional
// energy filter — Spotify/ReccoBeats' own "energy" audio feature is a
// continuous 0.0-1.0 value (already stored per-track in the library CSV and
// resolved for every online candidate, same as BPM), split into three even
// thirds rather than anything library-tuned.

export type EnergyBand = "low" | "medium" | "high";

const BAND_RANGES: Record<EnergyBand, [number, number]> = {
  low: [0, 0.33],
  medium: [0.33, 0.67],
  high: [0.67, 1],
};

export function energyInBand(energy: number, band: EnergyBand): boolean {
  const [min, max] = BAND_RANGES[band];
  return energy >= min && energy <= max;
}

export const ENERGY_BAND_LABELS: Record<EnergyBand, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};
