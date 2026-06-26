import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "runna-config.json");

export function loadRunnaUrl(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as { icsUrl?: string };
    return data?.icsUrl ?? null;
  } catch {
    return null;
  }
}

export function saveRunnaUrl(icsUrl: string): void {
  fs.writeFileSync(FILE, JSON.stringify({ icsUrl }), "utf-8");
}
