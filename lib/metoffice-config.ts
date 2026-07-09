import fs from "fs";
import path from "path";

// Met Office DataHub credentials + forecast location, configured in Settings.
// Location defaults to the user's home postcode (NG12 4BD) geocoded via
// postcodes.io; stored as lat/lon since that's what the API takes.
const FILE = path.join(process.cwd(), "metoffice-config.json");

export interface MetOfficeConfig {
  apiKey: string;
  postcode: string;
  lat: number;
  lon: number;
}

export const DEFAULT_LOCATION = { postcode: "NG12 4BD", lat: 52.914856, lon: -1.111856 };

export function loadMetOfficeConfig(): MetOfficeConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as MetOfficeConfig;
    if (data?.apiKey) return data;
  } catch {}
  return null;
}

export function saveMetOfficeConfig(config: MetOfficeConfig): void {
  fs.writeFileSync(FILE, JSON.stringify(config), "utf-8");
}
