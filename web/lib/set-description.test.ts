import { describe, it, expect, vi } from "vitest";
import { generateDescription, type GarminGateway, type SyncStore } from "hevy2garmin";
import {
  GARMIN_DESCRIPTION_LIMIT,
  buildSetDescription,
  fmtDuration,
  formatSet,
  rememberPendingWorkouts,
  rewriteDescription,
  withSetDescriptions,
} from "./set-description";

/** A Hevy workout in the API's shape. */
function workout(over: Record<string, unknown> = {}) {
  return {
    id: "w1",
    title: "Upper A",
    start_time: "2026-11-17T18:00:00Z",
    end_time: "2026-11-17T19:02:00Z",
    exercises: [
      {
        title: "Bench Press (Barbell)",
        sets: [
          { type: "normal", weight_kg: 60, reps: 12 },
          { type: "normal", weight_kg: 70, reps: 8 },
          { type: "normal", weight_kg: 80, reps: 5 },
          { type: "normal", weight_kg: 80, reps: 5 },
        ],
      },
      { title: "Push Up", sets: [{ type: "normal", weight_kg: null, reps: 25 }] },
      { title: "Hanging Knee Raise", sets: [1, 2, 3].map(() => ({ type: "normal", reps: 15 })) },
      { title: "Copenhagen Plank", sets: [1, 2, 3].map(() => ({ type: "normal", duration_seconds: 20 })) },
      { title: "Warm Up", sets: [{ type: "normal", duration_seconds: 300 }] },
    ],
    ...over,
  };
}

/** What the engine hands the gateway for this workout. */
const engineText = (w: Record<string, unknown>, kcal: number | null = 412, hr: number | null = 118) =>
  generateDescription(w, kcal, hr);

describe("formatSet", () => {
  it("weight × reps, without a trailing .0", () => {
    expect(formatSet({ weight_kg: 80, reps: 5 })).toBe("80×5");
    expect(formatSet({ weight_kg: 22.5, reps: 10 })).toBe("22.5×10");
    expect(formatSet({ weight_kg: 80.0, reps: 5 })).toBe("80×5");
  });

  it("bodyweight sets show reps only (null or 0 kg)", () => {
    expect(formatSet({ weight_kg: null, reps: 25 })).toBe("25");
    expect(formatSet({ weight_kg: 0, reps: 12 })).toBe("12");
  });

  it("timed sets show seconds or minutes, loaded ones with the weight", () => {
    expect(formatSet({ duration_seconds: 20 })).toBe("20s");
    expect(formatSet({ duration_seconds: 300 })).toBe("5min");
    expect(formatSet({ duration_seconds: 90 })).toBe("1min30s");
    expect(formatSet({ weight_kg: 32, duration_seconds: 40 })).toBe("32×40s");
    expect(fmtDuration(59.6)).toBe("1min");
  });

  it("distance sets, optionally with their time", () => {
    expect(formatSet({ distance_meters: 400 })).toBe("400m");
    expect(formatSet({ distance_meters: 2000, duration_seconds: 480 })).toBe("2km/8min");
    expect(formatSet({ weight_kg: 24, distance_meters: 40 })).toBe("24×40m");
  });

  it("marks warm-up, drop and failure sets and appends RPE", () => {
    expect(formatSet({ type: "warmup", weight_kg: 40, reps: 10 })).toBe("40×10w");
    expect(formatSet({ type: "dropset", weight_kg: 60, reps: 8 })).toBe("60×8d");
    expect(formatSet({ type: "failure", reps: 9 })).toBe("9f");
    expect(formatSet({ type: "normal", weight_kg: 80, reps: 5, rpe: 8 })).toBe("80×5 @8");
    expect(formatSet({ type: "warmup", weight_kg: 40, reps: 10, rpe: 6.5 })).toBe("40×10w @6.5");
  });

  it("a set logged with nothing filled in still shows up", () => {
    expect(formatSet({ type: "normal" })).toBe("—");
  });
});

describe("rewriteDescription", () => {
  it("lists every set in workout order and keeps the engine's header and footer", () => {
    const w = workout();
    const before = engineText(w);
    // The misleading summary this replaces: top weight and top reps of different sets.
    expect(before).toContain("• Bench Press (Barbell): 4 sets · 80.0kg × 12");

    expect(rewriteDescription(before, [w])).toBe(
      [
        "🏋️ Upper A",
        "⏱️ 62 min",
        "🔥 412 kcal",
        "❤️ avg 118 bpm",
        "",
        "• Bench Press (Barbell): 60×12, 70×8, 80×5, 80×5",
        "• Push Up: 25",
        "• Hanging Knee Raise: 15, 15, 15",
        "• Copenhagen Plank: 20s, 20s, 20s",
        "• Warm Up: 5min",
        "",
        "— synced by hevy2garmin",
      ].join("\n"),
    );
  });

  it("keeps warm-up sets in place, marked, instead of hiding them", () => {
    const w = workout({
      exercises: [
        {
          title: "Squat (Barbell)",
          sets: [
            { type: "warmup", weight_kg: 40, reps: 10 },
            { type: "normal", weight_kg: 80, reps: 5, rpe: 8 },
            { type: "dropset", weight_kg: 60, reps: 10 },
          ],
        },
        { title: "Band Pull Apart", sets: [{ type: "warmup", reps: 20 }] },
      ],
    });
    const out = rewriteDescription(engineText(w), [w]);
    expect(out).toContain("• Squat (Barbell): 40×10w, 80×5 @8, 60×10d");
    expect(out).toContain("• Band Pull Apart: 20w");
  });

  it("finds the right workout among several, using the kcal/HR the engine wrote", () => {
    const a = workout({ id: "a" });
    const b = workout({ id: "b", title: "Lower B", exercises: [{ title: "Deadlift (Barbell)", sets: [{ weight_kg: 140, reps: 3 }] }] });
    const out = rewriteDescription(engineText(b, null, null), [a, b]);
    expect(out).toBe(["🏋️ Lower B", "⏱️ 62 min", "", "• Deadlift (Barbell): 140×3", "", "— synced by hevy2garmin"].join("\n"));
  });

  it("leaves the text alone when the workout is unknown or ambiguous", () => {
    const w = workout();
    const text = engineText(w);
    expect(rewriteDescription(text, [])).toBe(text);
    expect(rewriteDescription("Some note the user wrote", [w])).toBe("Some note the user wrote");

    // Same summary line ("2 sets · 80.0kg × 5") but different sets: can't tell which.
    const x = workout({ id: "x", exercises: [{ title: "Row", sets: [{ weight_kg: 80, reps: 5 }, { weight_kg: 70, reps: 5 }] }] });
    const y = workout({ id: "y", exercises: [{ title: "Row", sets: [{ weight_kg: 70, reps: 5 }, { weight_kg: 80, reps: 5 }] }] });
    const ambiguous = engineText(x);
    expect(engineText(y)).toBe(ambiguous);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(rewriteDescription(ambiguous, [x, y])).toBe(ambiguous);
    warn.mockRestore();
  });

  it("is a no-op for a workout without exercises", () => {
    const w = workout({ exercises: [] });
    expect(rewriteDescription(engineText(w), [w])).toBe(engineText(w));
  });
});

describe("long workouts (Garmin's 2,000-character limit)", () => {
  /** n exercises × s distinct sets each, long names. */
  function big(n: number, s: number, repeat = false) {
    return workout({
      exercises: Array.from({ length: n }, (_, i) => ({
        title: `Single Arm Incline Bench Press Variation ${i + 1} (Dumbbell)`,
        sets: Array.from({ length: s }, (_, j) => ({ weight_kg: repeat ? 30 : 20 + j * 2.5, reps: 10, rpe: 8 })),
      })),
    });
  }
  const header = ["🏋️ Upper A", "⏱️ 62 min", "🔥 412 kcal", "❤️ avg 118 bpm"];
  const countSets = (text: string) =>
    text.split("\n").filter((l) => l.startsWith("• ")).reduce((a, l) => {
      const sets = l.slice(l.indexOf(": ") + 2).split(", ");
      return a + sets.reduce((b, x) => b + (x.match(/ ×(\d+)$/) ? Number(x.match(/ ×(\d+)$/)![1]) : 1), 0);
    }, 0);

  it("fits as-is when short", () => {
    const out = buildSetDescription(workout(), header);
    expect(out).toContain("🔥 412 kcal");
    expect(out.length).toBeLessThan(GARMIN_DESCRIPTION_LIMIT);
  });

  it("drops the kcal line first, keeping every set and full names", () => {
    const w = big(12, 6);
    const full = buildSetDescription(w, header, 100_000);
    const limit = full.length - 5; // just over: removing the kcal line is enough
    const out = buildSetDescription(w, header, limit);
    expect(out.length).toBeLessThanOrEqual(limit);
    expect(out).not.toContain("kcal");
    expect(out).toContain("❤️ avg 118 bpm");
    expect(out).toContain("Single Arm Incline Bench Press Variation 1 (Dumbbell)");
    expect(countSets(out)).toBe(72);
  });

  it("then abbreviates names and collapses repeats, still keeping every set", () => {
    const w = big(20, 8, true); // 160 identical sets → "30×10 @8 ×8"
    const out = buildSetDescription(w, header);
    expect(out.length).toBeLessThanOrEqual(GARMIN_DESCRIPTION_LIMIT);
    expect(out).toContain("(DB)");
    expect(out).toContain("30×10 @8 ×8");
    expect(countSets(out)).toBe(160);
    expect(out.endsWith("— synced by hevy2garmin")).toBe(true);
  });

  it("as a last resort says what it left out instead of cutting silently", () => {
    const w = big(40, 10); // 400 distinct sets cannot fit in 2,000 characters
    const out = buildSetDescription(w, header);
    expect(out.length).toBeLessThanOrEqual(GARMIN_DESCRIPTION_LIMIT);
    const note = out.split("\n").find((l) => l.startsWith("… +"))!;
    expect(note).toMatch(/^… \+(\d+) more exercises \((\d+) sets\) not shown: Garmin's 2000-character limit\. Full log in Hevy\.$/);
    const [, hiddenEx, hiddenSets] = note.match(/\+(\d+) more exercises \((\d+) sets\)/)!.map(Number);
    expect(countSets(out) + hiddenSets).toBe(400);
    expect(out.split("\n").filter((l) => l.startsWith("• ")).length + hiddenEx).toBe(40);
    expect(out.endsWith("— synced by hevy2garmin")).toBe(true);
  });
});

describe("wiring", () => {
  it("withSetDescriptions rewrites what reaches Garmin and passes everything else through", async () => {
    const describe = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const gateway = withSetDescriptions({ describe, rename } as unknown as GarminGateway, () => [w]);
    const w = workout();
    await gateway.describe(123, engineText(w));
    expect(describe).toHaveBeenCalledWith(123, expect.stringContaining("60×12, 70×8, 80×5, 80×5"));
    await gateway.rename(123, "Upper A");
    expect(rename).toHaveBeenCalledWith(123, "Upper A");
  });

  it("rememberPendingWorkouts captures the workout stored in pending rows (recovery path)", async () => {
    const stored = workout({ id: "p1" });
    const base = {
      getPending: vi.fn(async () => ({ payload: { workout: stored } })),
      claimPending: vi.fn(async () => true),
      isSynced: vi.fn(),
    } as unknown as SyncStore;
    const seen: unknown[] = [];
    const store = rememberPendingWorkouts(base, (w) => seen.push(w));
    await store.getPending("p1");
    await store.claimPending("p2", { workout: { id: "p2" } });
    expect(seen).toEqual([stored, { id: "p2" }]);
    expect(store.isSynced).toBe(base.isSynced);
  });
});
