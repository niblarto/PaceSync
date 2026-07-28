import fs from "fs";
import path from "path";

// Whether the dashboard's left "Heart Rate Zones" column is hidden — a
// display preference toggled from Settings > Integrations (next to AI DJ),
// persisted server-side like the other simple on/off switches in this app.

const FILE = path.join(process.cwd(), "dashboard-layout.json");

export function getZonesColumnHidden(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as { zonesColumnHidden?: boolean };
    return data.zonesColumnHidden ?? false;
  } catch {
    return false;
  }
}

export function setZonesColumnHidden(hidden: boolean): void {
  fs.writeFileSync(FILE, JSON.stringify({ zonesColumnHidden: hidden }), "utf-8");
}
