import { describe, expect, it } from "vitest";
import {
  LlmProposalSchema, proposalOutputFormat, toAutomationSpec, toCommand, toInternalAction,
  type LlmAction, type LlmProposal,
} from "../assistant";
import { AutomationSpecSchema } from "../automations";
import { CommandSchema } from "../commands";

describe("LlmProposalSchema", () => {
  it("accepts each proposal kind", () => {
    const proposals: unknown[] = [
      { kind: "clarify", message: "Which room?" },
      {
        kind: "actions",
        message: "Turning off the kitchen lights.",
        actions: [{ type: "room", room: "Kitchen", command: "lights_off" }],
      },
      { kind: "scene_capture", message: "Saving.", name: "Cozy", room: "Lounge" },
      {
        kind: "automation",
        message: "Kitchen on at 16:00 tomorrow, off at 20:00.",
        name: "Kitchen tomorrow",
        steps: [
          { time: "16:00", sun: null, sunOffsetMinutes: null, days: null, date: "2026-07-18", actions: [{ type: "room", room: "Kitchen", command: "lights_on" }] },
          { time: "20:00", sun: null, sunOffsetMinutes: null, days: null, date: "2026-07-18", actions: [{ type: "room", room: "Kitchen", command: "lights_off" }] },
        ],
      },
      {
        kind: "automation",
        message: "Balcony lights 15 min before sunset, off at 01:00.",
        name: "Balcony dusk",
        steps: [
          { time: null, sun: "sunset", sunOffsetMinutes: -15, days: null, date: null, actions: [{ type: "room", room: "Balcony (6th)", command: "lights_on" }] },
          { time: "01:00", sun: null, sunOffsetMinutes: null, days: null, date: null, actions: [{ type: "room", room: "Balcony (6th)", command: "lights_off" }] },
        ],
      },
    ];
    for (const p of proposals) {
      expect(LlmProposalSchema.safeParse(p).success, JSON.stringify(p)).toBe(true);
    }
  });

  it("rejects unknown kinds and malformed actions", () => {
    expect(LlmProposalSchema.safeParse({ kind: "delete_everything", message: "x" }).success).toBe(false);
    expect(
      LlmProposalSchema.safeParse({
        kind: "actions", message: "x",
        actions: [{ type: "device", deviceId: "d1", command: "self_destruct", value: null }],
      }).success,
    ).toBe(false);
  });
});

describe("toCommand", () => {
  it("maps simple commands without values", () => {
    const cmd = toCommand({ type: "device", deviceId: "d", command: "turn_on", value: null });
    expect(cmd).toEqual({ command: "turn_on" });
    expect(CommandSchema.safeParse(cmd).success).toBe(true);
  });

  it("maps value commands and rounds percentages", () => {
    expect(toCommand({ type: "device", deviceId: "d", command: "set_brightness", value: 49.6 }))
      .toEqual({ command: "set_brightness", brightnessPct: 50 });
    expect(toCommand({ type: "device", deviceId: "d", command: "set_position", value: 25 }))
      .toEqual({ command: "set_position", positionPct: 25 });
    expect(toCommand({ type: "device", deviceId: "d", command: "set_temperature", value: 21.5 }))
      .toEqual({ command: "set_temperature", temperature: 21.5 });
    expect(toCommand({ type: "device", deviceId: "d", command: "set_volume", value: 30 }))
      .toEqual({ command: "set_volume", volumePct: 30 });
  });

  it("throws when a value command comes without a value", () => {
    for (const command of ["set_brightness", "set_position", "set_temperature", "set_volume"] as const) {
      expect(() => toCommand({ type: "device", deviceId: "d", command, value: null })).toThrow();
    }
  });
});

describe("toInternalAction", () => {
  it("passes scene and room actions through", () => {
    expect(toInternalAction({ type: "scene", sceneId: "s1" })).toEqual({ type: "scene", sceneId: "s1" });
    expect(toInternalAction({ type: "room", room: "Study", command: "lights_on" }))
      .toEqual({ type: "room", room: "Study", command: "lights_on" });
  });

  it("converts device actions into internal command objects", () => {
    const a: LlmAction = { type: "device", deviceId: "d9", command: "set_brightness", value: 80 };
    expect(toInternalAction(a)).toEqual({
      type: "device", deviceId: "d9", command: { command: "set_brightness", brightnessPct: 80 },
    });
  });
});

describe("toAutomationSpec", () => {
  const proposal: Extract<LlmProposal, { kind: "automation" }> = {
    kind: "automation",
    message: "Kitchen on tomorrow at 16:00, off at 20:00.",
    name: "Kitchen tomorrow",
    steps: [
      { time: "16:00", sun: null, sunOffsetMinutes: null, days: null, date: "2026-07-18", actions: [{ type: "room", room: "Kitchen", command: "lights_on" }] },
      { time: "20:00", sun: null, sunOffsetMinutes: null, days: null, date: "2026-07-18", actions: [{ type: "room", room: "Kitchen", command: "lights_off" }] },
    ],
  };

  it("produces a spec the internal schema accepts", () => {
    const spec = toAutomationSpec(proposal);
    expect(AutomationSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.steps[0]).toEqual({
      time: "16:00", date: "2026-07-18",
      actions: [{ type: "room", room: "Kitchen", command: "lights_on" }],
    });
    expect(spec.steps[0]).not.toHaveProperty("days");
    expect(spec.steps[0]).not.toHaveProperty("sun");
  });

  it("keeps recurring day lists and drops empty ones", () => {
    const weekly = toAutomationSpec({
      ...proposal,
      steps: [{ time: "07:30", sun: null, sunOffsetMinutes: null, days: [1, 2, 3, 4, 5], date: null, actions: [{ type: "scene", sceneId: "s1" }] }],
    });
    expect(weekly.steps[0].days).toEqual([1, 2, 3, 4, 5]);
    expect(weekly.steps[0]).not.toHaveProperty("date");

    const daily = toAutomationSpec({
      ...proposal,
      steps: [{ time: "07:30", sun: null, sunOffsetMinutes: null, days: [], date: null, actions: [{ type: "scene", sceneId: "s1" }] }],
    });
    expect(daily.steps[0]).not.toHaveProperty("days");
    expect(AutomationSpecSchema.safeParse(daily).success).toBe(true);
  });

  it("maps sun triggers, keeping offset and dropping time", () => {
    const dusk = toAutomationSpec({
      ...proposal,
      steps: [
        { time: null, sun: "sunset", sunOffsetMinutes: -15, days: null, date: null, actions: [{ type: "room", room: "Balcony (6th)", command: "lights_on" }] },
        { time: "01:00", sun: null, sunOffsetMinutes: null, days: null, date: null, actions: [{ type: "room", room: "Balcony (6th)", command: "lights_off" }] },
      ],
    });
    expect(dusk.steps[0]).toEqual({
      sun: "sunset", sunOffsetMinutes: -15,
      actions: [{ type: "room", room: "Balcony (6th)", command: "lights_on" }],
    });
    expect(dusk.steps[0]).not.toHaveProperty("time");
    // a zero/again-null offset collapses to a bare sun trigger
    expect(dusk.steps[1]).toEqual({ time: "01:00", actions: [{ type: "room", room: "Balcony (6th)", command: "lights_off" }] });
    expect(AutomationSpecSchema.safeParse(dusk).success).toBe(true);
  });

  it("collapses a zero sun offset to a bare sun trigger", () => {
    const spec = toAutomationSpec({
      ...proposal,
      steps: [{ time: null, sun: "sunrise", sunOffsetMinutes: 0, days: null, date: null, actions: [{ type: "scene", sceneId: "s1" }] }],
    });
    expect(spec.steps[0]).toEqual({ sun: "sunrise", actions: [{ type: "scene", sceneId: "s1" }] });
    expect(AutomationSpecSchema.safeParse(spec).success).toBe(true);
  });
});

describe("proposalOutputFormat", () => {
  it("emits a schema with no $defs/$ref (Anthropic rejects them under anyOf)", () => {
    const fmt = proposalOutputFormat();
    const json = JSON.stringify(fmt.schema);
    expect(json).not.toContain("$defs");
    expect(json).not.toContain("$ref");
  });
});
