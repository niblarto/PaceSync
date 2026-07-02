import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { spawn } from "child_process";
import path from "path";

const PYTHON = process.platform === "win32" ? "python" : "python3";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uri, n, seed } = await req.json() as { uri?: string; n?: number; seed?: object };
  if (!uri) return NextResponse.json({ error: "Missing uri" }, { status: 400 });

  const script = path.join(process.cwd(), "scripts", "bpm_bridge.py");
  const csv = path.join(process.cwd(), "public", "Running.csv");

  const args = [script, "similar", csv, uri, String(n ?? 25)];
  if (seed) args.push(JSON.stringify(seed));

  return new Promise<NextResponse>((resolve) => {
    const proc = spawn(PYTHON, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(NextResponse.json({ error: stderr.trim() || `python exited ${code}` }, { status: 500 }));
        return;
      }
      try {
        resolve(NextResponse.json(JSON.parse(stdout)));
      } catch {
        resolve(NextResponse.json({ error: "Bad JSON from matcher" }, { status: 500 }));
      }
    });
    proc.on("error", (err) => {
      resolve(NextResponse.json({ error: err.message }, { status: 500 }));
    });
  });
}
