import fs from "fs";
import path from "path";

// Global on/off switch for dropping BBC-imported tracks whose BPM falls
// outside the library's zone coverage (see lib/bbc-bpm-filter.ts). Applies
// to both the manual BBC card flow and the weekly cron.

const FILE = path.join(process.cwd(), "bbc-bpm-filter.json");

export function getBbcBpmFilterEnabled(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as { enabled?: boolean };
    return data.enabled ?? false;
  } catch {
    return false;
  }
}

export function setBbcBpmFilterEnabled(enabled: boolean): void {
  fs.writeFileSync(FILE, JSON.stringify({ enabled }), "utf-8");
}
