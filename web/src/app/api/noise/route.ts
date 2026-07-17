import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { noiseConfigured, setNoiseType, setNoiseVolume, type NoiseType } from "@/lib/whitenoise";

/** Control the white-noise machine's sound: type and volume. On/off is
 *  Control4's job (the bedside button owns the bedroom zone). */
export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!noiseConfigured()) return NextResponse.json({ error: "white noise is not configured" }, { status: 501 });

  const body = (await req.json().catch(() => null)) as
    | { noiseType?: unknown; volumePct?: unknown }
    | null;
  const noiseType =
    body?.noiseType === "white" || body?.noiseType === "brown" || body?.noiseType === "pink"
      ? (body.noiseType as NoiseType)
      : undefined;
  const volumePct = typeof body?.volumePct === "number" ? body.volumePct : undefined;
  if (noiseType == null && volumePct == null) {
    return NextResponse.json({ error: "noiseType or volumePct required" }, { status: 400 });
  }
  if (volumePct != null && (volumePct < 0 || volumePct > 100)) {
    return NextResponse.json({ error: "volumePct must be 0-100" }, { status: 400 });
  }

  const started = Date.now();
  try {
    let status = noiseType != null ? await setNoiseType(noiseType) : null;
    if (volumePct != null) status = await setNoiseVolume(volumePct);
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "master_bedroom__white_noise",
      entityId: "virtual.white_noise", command: "set_noise",
      args: { noiseType, volumePct }, ok: true, durationMs: Date.now() - started,
    });
    return NextResponse.json({ ok: true, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "noise command failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "master_bedroom__white_noise",
      entityId: "virtual.white_noise", command: "set_noise",
      args: { noiseType, volumePct }, ok: false, durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
