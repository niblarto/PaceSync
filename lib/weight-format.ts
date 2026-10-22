// Client-safe weight formatting. Weights are stored in kg everywhere.
export type WeightUnit = "kg" | "st" | "lb";

export const LB_PER_KG = 2.20462;

export function kgToStLb(kg: number): { st: number; lb: number } {
  const totalLb = kg * LB_PER_KG;
  let st = Math.floor(totalLb / 14);
  let lb = Math.round((totalLb - st * 14) * 10) / 10;
  if (lb >= 14) { st += 1; lb -= 14; }
  return { st, lb };
}

export function stLbToKg(st: number, lb: number): number {
  return (st * 14 + lb) / LB_PER_KG;
}

// e.g. "13 st 2.4 lb", "184.9 lb", "83.9 kg"
export function formatWeight(kg: number | null | undefined, unit: WeightUnit, opts: { decimals?: boolean; exact?: boolean } = {}): string {
  if (kg == null || !Number.isFinite(kg)) return "—";
  if (opts.exact) {
    if (unit === "kg") return `${kg.toFixed(2)} kg`;
    const totalLb = kg * LB_PER_KG;
    if (unit === "lb") return `${totalLb.toFixed(2)} lb`;
    const st = Math.floor(totalLb / 14);
    return `${st} st ${(totalLb - st * 14).toFixed(2)} lb`;
  }
  const dec = opts.decimals ?? true;
  if (unit === "kg") return `${kg.toFixed(dec ? 1 : 0)} kg`;
  if (unit === "lb") return `${(kg * LB_PER_KG).toFixed(dec ? 1 : 0)} lb`;
  const { st, lb } = kgToStLb(kg);
  return `${st} st ${dec ? lb.toFixed(1) : Math.round(lb)} lb`;
}

// Signed change, e.g. "−1.2 lb/wk" style values. Stones view shows lb.
export function formatWeightDelta(kg: number, unit: WeightUnit): string {
  const sign = kg > 0 ? "+" : kg < 0 ? "−" : "";
  const abs = Math.abs(kg);
  if (unit === "kg") return `${sign}${abs.toFixed(2)} kg`;
  const lb = abs * LB_PER_KG;
  if (unit === "st" && lb >= 14) {
    const { st, lb: rem } = kgToStLb(abs);
    return `${sign}${st} st ${rem.toFixed(1)} lb`;
  }
  return `${sign}${lb.toFixed(1)} lb`;
}
