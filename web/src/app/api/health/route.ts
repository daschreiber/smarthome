import { NextRequest, NextResponse } from "next/server";
import { haHealth } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { authorized } from "@/lib/auth";
import { saunaConfigured, saunaStatus } from "@/lib/sauna";

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ha = await haHealth();
  let sauna: { configured: boolean; ok: boolean; message: string };
  if (!saunaConfigured()) {
    sauna = { configured: false, ok: false, message: "SAUNA_BASE_URL / SAUNA_API_TOKEN not set" };
  } else {
    try {
      const st = await saunaStatus();
      sauna = {
        configured: true,
        ok: st.connected,
        message: st.connected
          ? `reachable; cabin ${st.currentTemperature}°, ${st.poweredOn ? "heating" : "idle"}`
          : "sauna service reachable, but the sauna itself is offline at KLAFS",
      };
    } catch (err) {
      sauna = { configured: true, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return NextResponse.json({
    app: "ok",
    homeAssistant: ha,
    sauna,
    devices: registry().devices.length,
  });
}
