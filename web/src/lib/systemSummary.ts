/**
 * The one line under a system tile ("4 zones active", "all off",
 * "not responding") — shared by the Home view and the Systems index so the
 * two can never disagree about the same house.
 *
 * "all off" is a claim about EVERY device in the system, and it is the claim
 * an outage quietly turns into a lie: when Home Assistant loses the Control4
 * link, its entities read `unavailable`, none of them read "on", and a naive
 * count renders a dead system as a tidy "all off" (2026-08-12, and again
 * 2026-08-21 — the Underfloor heating tile said "all off" while every valve
 * relay was unreachable). Counting the unreachable ones and naming them is
 * the whole point.
 *
 * Keyed on `unreachable`, not `!available`: "unknown" is the transient state
 * after an HA restart and stays commandable (lib/reachability).
 */
export function systemSummary(
  on: number,
  total: number,
  down: number,
  onLabel: (n: number) => string,
  offLabel = "all off",
): string {
  // Everything down: the system has no state to report, only an outage.
  if (total > 0 && down === total) return "not responding";
  return (on > 0 ? onLabel(on) : offLabel) + (down > 0 ? ` · ${down} not responding` : "");
}
