import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadAiDjConfig } from "@/lib/ai-dj-config";
import dgram from "dgram";

// Wake-on-LAN: broadcasts a magic packet for the AI DJ host's MAC (saved in
// Settings) from the Pi, which shares the PC's LAN. Sent a few times to ports
// 9 and 7 — WOL is fire-and-forget UDP, repeats cost nothing and help.
function magicPacket(mac: string): Buffer {
  const clean = mac.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length !== 12) throw new Error("Invalid MAC address");
  const macBuf = Buffer.from(clean, "hex");
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
  return packet;
}

function broadcast(packet: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", err => { socket.close(); reject(err); });
    socket.bind(() => {
      socket.setBroadcast(true);
      let pending = 6;
      const done = () => { if (--pending === 0) { socket.close(); resolve(); } };
      for (let i = 0; i < 3; i++) {
        socket.send(packet, 9, "255.255.255.255", done);
        socket.send(packet, 7, "255.255.255.255", done);
      }
    });
  });
}

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const mac = loadAiDjConfig()?.wolMac?.trim();
  if (!mac) return NextResponse.json({ error: "No MAC address saved — add it in the AI DJ settings." }, { status: 400 });

  try {
    await broadcast(magicPacket(mac));
    console.log(`[ai-dj/wake] magic packet sent to ${mac}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
