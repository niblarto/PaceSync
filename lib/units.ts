// Recipe measures. Recipes come in American measures (cups, tablespoons, oz, lb). Settings → Nutrition → Recipe
// measures decides, per measure, whether it is converted to metric (grams or millilitres) before being matched to a
// Lose It! food's own unit, and how many ml/g one of it is worth; the rest are left as written.
// Client-safe (no database); the stored settings are in lib/measures-config.ts.

export type MeasureKey = "teaspoon" | "tablespoon" | "fluid ounce" | "cup" | "pint" | "quart" | "ounce" | "pound";

export interface MeasureDef {
  key: MeasureKey;
  label: string;            // "1 cup"
  metricUnit: "ml" | "g";
  defaultMetric: number;    // how many ml/g it is
  defaultConvert: boolean;
  loseIt: string;           // the same measure's name in Lose It!
}

export const MEASURE_DEFS: MeasureDef[] = [
  { key: "teaspoon", label: "1 teaspoon (tsp)", metricUnit: "ml", defaultMetric: 4.93, defaultConvert: false, loseIt: "Teaspoon" },
  { key: "tablespoon", label: "1 tablespoon (tbsp)", metricUnit: "ml", defaultMetric: 14.79, defaultConvert: false, loseIt: "Tablespoon" },
  { key: "fluid ounce", label: "1 fluid ounce (fl oz)", metricUnit: "ml", defaultMetric: 29.57, defaultConvert: true, loseIt: "Fluid Ounce" },
  { key: "cup", label: "1 cup", metricUnit: "ml", defaultMetric: 236.59, defaultConvert: true, loseIt: "Cup" },
  { key: "pint", label: "1 pint", metricUnit: "ml", defaultMetric: 473.18, defaultConvert: true, loseIt: "Pint" },
  { key: "quart", label: "1 quart", metricUnit: "ml", defaultMetric: 946.35, defaultConvert: true, loseIt: "Quart" },
  { key: "ounce", label: "1 ounce (oz)", metricUnit: "g", defaultMetric: 28.35, defaultConvert: true, loseIt: "Ounce" },
  { key: "pound", label: "1 pound (lb)", metricUnit: "g", defaultMetric: 453.59, defaultConvert: true, loseIt: "Pound" },
];

export type MeasureSettings = Record<MeasureKey, { convert: boolean; metric: number }>;

export function defaultMeasures(): MeasureSettings {
  return Object.fromEntries(MEASURE_DEFS.map(d => [d.key, { convert: d.defaultConvert, metric: d.defaultMetric }])) as MeasureSettings;
}

export function sanitizeMeasures(raw: unknown): MeasureSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, { convert?: unknown; metric?: unknown } | undefined>;
  const out = defaultMeasures();
  for (const d of MEASURE_DEFS) {
    const v = r[d.key];
    const metric = typeof v?.metric === "number" ? v.metric : typeof v?.metric === "string" ? Number(v.metric) : NaN;
    out[d.key] = {
      convert: typeof v?.convert === "boolean" ? v.convert : d.defaultConvert,
      metric: Number.isFinite(metric) && metric > 0 && metric <= 100_000 ? metric : d.defaultMetric,
    };
  }
  return out;
}

// How recipe unit spellings map to the measures above.
const ALIASES: Record<string, MeasureKey> = {
  tsp: "teaspoon", teaspoon: "teaspoon", tbsp: "tablespoon", tbs: "tablespoon", tablespoon: "tablespoon",
  "fl oz": "fluid ounce", floz: "fluid ounce", "fluid ounce": "fluid ounce", cup: "cup", c: "cup", pint: "pint", pt: "pint",
  quart: "quart", qt: "quart", oz: "ounce", ounce: "ounce", lb: "pound", pound: "pound",
};

// Not in the settings: always metric, or fixed.
const FIXED_G: Record<string, number> = { g: 1, gram: 1, gr: 1, kg: 1000, kilogram: 1000, mg: 0.001, stick: 113.4 }; // a US stick of butter
const FIXED_ML: Record<string, number> = { ml: 1, milliliter: 1, millilitre: 1, l: 1000, liter: 1000, litre: 1000, gallon: 3785.41, gal: 3785.41, pinch: 0.3, dash: 0.6, splash: 5 };
const COUNTS = new Set(["", "each", "piece", "whole", "clove", "slice", "can", "tin", "bunch", "sprig", "head", "stalk", "fillet", "breast", "large", "medium", "small", "package", "pack", "jar", "bottle", "bag", "cube", "leaf", "ear"]);

function normalise(unit: string | null): string {
  // FatSecret describes some units with a note after the measure: "tsp, leaves", "cup (chopped)". The measure is the first part.
  let u = (unit ?? "").toLowerCase().split(/[,(]/)[0].trim().replace(/\./g, "").replace(/\s+/g, " ");
  if (u === "fl oz" || u === "fluid ounces" || u === "fluid ounce" || u === "fl ounce" || u === "fl ounces") return "fl oz";
  if (u === "lbs") return "lb";
  if (u.length > 3 && u.endsWith("s") && !u.endsWith("ss")) u = u.slice(0, -1); // cups → cup, ounces → ounce
  return u;
}

// amount/unit: the metric amount (g, ml, or a count). keep: set when the measure is to be left as written (its
// Convert box is off): the original quantity and measure, with the metric amount still there for when the Lose It!
// food has no matching unit.
export interface Metric {
  amount: number; unit: "g" | "ml" | "count"; countUnit: string | null;
  keep: { key: MeasureKey; quantity: number; label: string } | null;
}

const SHORT: Partial<Record<MeasureKey, string>> = { teaspoon: "tsp", tablespoon: "tbsp", "fluid ounce": "fl oz", ounce: "oz", pound: "lb" };

// quantity + American unit → metric. null when there is no usable amount.
export function toMetric(quantity: number | null, unit: string | null, settings: MeasureSettings = defaultMeasures()): Metric | null {
  if (quantity == null || !(quantity > 0)) return null;
  const u = normalise(unit);
  const key = ALIASES[u];
  if (key) {
    const def = MEASURE_DEFS.find(d => d.key === key)!;
    const s = settings[key];
    return {
      amount: quantity * s.metric, unit: def.metricUnit === "g" ? "g" : "ml", countUnit: null,
      keep: s.convert ? null : { key, quantity, label: SHORT[key] ?? key },
    };
  }
  if (FIXED_G[u] != null) return { amount: quantity * FIXED_G[u], unit: "g", countUnit: null, keep: null };
  if (FIXED_ML[u] != null) return { amount: quantity * FIXED_ML[u], unit: "ml", countUnit: null, keep: null };
  return { amount: quantity, unit: "count", countUnit: COUNTS.has(u) ? (u || null) : u, keep: null };
}

// Lose It!'s own units, in grams / millilitres each, for converting a metric amount into a food's unit.
export const LOSEIT_MASS_G: Record<string, number> = { Gram: 1, Kilogram: 1000, Milligram: 0.001, Microgram: 0.000001, Ounce: 28.3495, Pound: 453.592 };
export const LOSEIT_VOLUME_ML: Record<string, number> = {
  Milliliter: 1, Liter: 1000, Teaspoon: 4.92892, Tablespoon: 14.7868, Cup: 236.588, "Fluid Ounce": 29.5735, Pint: 473.176, Quart: 946.353,
  Gallon: 3785.41, "Metric Cup": 250, "Imperial Fluid Ounce": 28.4131, "Imperial Pint": 568.261, "Imperial Quart": 1136.52,
  "Imperial Gallon": 4546.09, Dessertspoon: 10,
};
