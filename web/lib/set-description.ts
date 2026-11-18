/**
 * Per-set activity descriptions (fork change; see `withSetDescriptions`).
 *
 * The engine (`hevy2garmin` on npm) describes each exercise with one summary
 * line, "4 sets · 80.0kg × 12": the top weight and the top reps, even when they
 * came from different sets. This module rewrites the exercise lines to list
 * every set, in workout order:
 *
 *   • Bench Press (Barbell): 40×10w, 60×12, 70×8, 80×5 @8, 80×5
 *   • Push Up: 25
 *   • Copenhagen Plank: 20s, 20s, 20s
 *
 * The engine's header (name, duration, kcal, avg HR) and its footer are kept
 * exactly as the engine wrote them; only the exercise block changes.
 *
 * It hooks in at the one place every path already goes through: the gateway's
 * `describe`, used by merge, match/replace, a fresh upload and the recovery
 * retry. Nothing in the engine is patched, so this file plus a few lines in
 * sync-one.ts is the whole fork delta.
 */
import { generateDescription, type GarminGateway, type SyncStore } from "hevy2garmin";

type Rec = Record<string, unknown>;

/**
 * Garmin Connect refuses activity descriptions over 2,000 characters (user
 * reports on Garmin's forums; there is no official figure). JS `length` counts
 * UTF-16 units, so emoji count double here, which errs on the safe side.
 */
export const GARMIN_DESCRIPTION_LIMIT = 2000;

const FOOTER = "— synced by hevy2garmin";

// ---------------------------------------------------------------------------
// One set → "80×5", "25", "20s", "40×10w", "80×5 @8"
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** 80 → "80", 22.5 → "22.5", 2.25 → "2.25". Never "80.0". */
export function fmtNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 20 → "20s", 300 → "5min", 330 → "5min30s". */
export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}min${rest}s` : `${m}min`;
}

/** 400 → "400m", 1200 → "1.2km". */
export function fmtDistance(meters: number): string {
  return meters < 1000 ? `${fmtNumber(meters)}m` : `${fmtNumber(meters / 1000)}km`;
}

const TYPE_SUFFIX: Record<string, string> = { warmup: "w", dropset: "d", failure: "f" };

export function formatSet(set: Rec): string {
  const weight = num(set.weight_kg ?? set.weight);
  const reps = num(set.reps);
  const duration = num(set.duration_seconds);
  const distance = num(set.distance_meters);
  const loaded = weight != null && weight > 0;
  const w = loaded ? `${fmtNumber(weight)}×` : "";

  let body: string;
  if (reps != null && reps > 0) body = `${w}${fmtNumber(reps)}`;
  else if (distance != null && distance > 0) {
    body = `${w}${fmtDistance(distance)}`;
    if (duration != null && duration > 0) body += `/${fmtDuration(duration)}`;
  } else if (duration != null && duration > 0) body = `${w}${fmtDuration(duration)}`;
  else if (loaded) body = `${fmtNumber(weight)}kg`;
  else body = "—"; // logged with nothing filled in: still a set, so still shown

  const suffix = TYPE_SUFFIX[String(set.type ?? "").toLowerCase()] ?? "";
  const rpe = num(set.rpe);
  return `${body}${suffix}${rpe != null ? ` @${fmtNumber(rpe)}` : ""}`;
}

// ---------------------------------------------------------------------------
// Exercise lines and the length budget
// ---------------------------------------------------------------------------

interface ExerciseLine {
  name: string;
  sets: string[];
}

function exerciseLines(workout: Rec): ExerciseLine[] {
  const exercises = (workout.exercises as Rec[] | undefined) ?? [];
  return exercises
    .map((ex) => ({
      name: String(ex.title ?? ex.name ?? "Unknown"),
      sets: ((ex.sets as Rec[] | undefined) ?? []).map(formatSet),
    }))
    .filter((e) => e.sets.length > 0); // the engine also leaves out exercises with no sets
}

const EQUIPMENT_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bSmith Machine\b/g, "Smith"],
  [/\bBarbell\b/g, "BB"],
  [/\bDumbbells?\b/g, "DB"],
  [/\bKettlebells?\b/g, "KB"],
  [/\bMachine\b/g, "Mach"],
  [/\bBodyweight\b/g, "BW"],
  [/\bResistance Band\b/g, "Band"],
  [/\bWeighted\b/g, "Wtd"],
];

function abbreviate(name: string): string {
  return EQUIPMENT_ABBREVIATIONS.reduce((n, [re, short]) => n.replace(re, short), name);
}

function truncateName(name: string, max = 22): string {
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
}

/** Lossless: "80×5, 80×5, 80×5" → "80×5 ×3". Every set is still accounted for. */
function collapseRepeats(sets: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < sets.length; ) {
    let j = i;
    while (j + 1 < sets.length && sets[j + 1] === sets[i]) j++;
    const n = j - i + 1;
    out.push(n > 1 ? `${sets[i]} ×${n}` : sets[i]);
    i = j + 1;
  }
  return out;
}

interface Level {
  dropCalories: boolean;
  abbreviateNames: boolean;
  collapse: boolean;
  truncateNames: boolean;
}

/** Tried in order until the description fits. Earlier levels lose nothing. */
const LEVELS: Level[] = [
  { dropCalories: false, abbreviateNames: false, collapse: false, truncateNames: false },
  { dropCalories: true, abbreviateNames: false, collapse: false, truncateNames: false },
  { dropCalories: true, abbreviateNames: true, collapse: false, truncateNames: false },
  { dropCalories: true, abbreviateNames: true, collapse: true, truncateNames: false },
  { dropCalories: true, abbreviateNames: true, collapse: true, truncateNames: true },
];

function render(lines: ExerciseLine[], level: Level): string[] {
  return lines.map((e) => {
    let name = e.name;
    if (level.abbreviateNames) name = abbreviate(name);
    if (level.truncateNames) name = truncateName(name);
    const sets = level.collapse ? collapseRepeats(e.sets) : e.sets;
    return `• ${name}: ${sets.join(", ")}`;
  });
}

function assemble(header: string[], body: string[]): string {
  return [...header, ...(body.length ? ["", ...body] : []), "", FOOTER].join("\n");
}

/**
 * The description for `workout`, keeping `header` (the engine's lines above the
 * exercises) as given. Shortens in the order of LEVELS; if even the most compact
 * form is too long, drops whole trailing exercise lines and SAYS so in a final
 * line, so a set is never lost without a trace.
 */
export function buildSetDescription(
  workout: Rec,
  header: string[],
  maxLength: number = GARMIN_DESCRIPTION_LIMIT,
): string {
  const lines = exerciseLines(workout);
  for (const level of LEVELS) {
    const h = level.dropCalories ? header.filter((l) => !l.startsWith("🔥")) : header;
    const text = assemble(h, render(lines, level));
    if (text.length <= maxLength) return text;
  }

  // Last resort: keep as many exercises as fit and name what was left out.
  const level = LEVELS[LEVELS.length - 1];
  const h = header.filter((l) => !l.startsWith("🔥"));
  const body = render(lines, level);
  for (let keep = body.length - 1; keep >= 0; keep--) {
    const hidden = lines.slice(keep);
    const hiddenSets = hidden.reduce((a, e) => a + e.sets.length, 0);
    const note = `… +${hidden.length} more exercise${hidden.length === 1 ? "" : "s"} (${hiddenSets} sets) not shown: Garmin's ${maxLength}-character limit. Full log in Hevy.`;
    const text = assemble(h, [...body.slice(0, keep), note]);
    if (text.length <= maxLength) return text;
  }
  return assemble(h, []).slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Wiring: rewrite what the engine writes, at the gateway
// ---------------------------------------------------------------------------

function parseNumberLine(text: string, re: RegExp): number | null {
  const m = text.match(re);
  return m ? num(m[1]) : null;
}

/**
 * The engine text → its per-set version, or the engine text unchanged when the
 * workout can't be identified with certainty.
 *
 * The gateway is only handed the finished string, so the workout is found by
 * running the engine's own `generateDescription` over the workouts this sync has
 * seen and keeping the one whose output is byte-for-byte the text received.
 * kcal and avg HR are read back from the text for that call. Using the engine's
 * function (not a copy of it) keeps this working across engine upgrades.
 */
export function rewriteDescription(engineText: string, candidates: Iterable<object>): string {
  if (!engineText.trimEnd().endsWith(FOOTER)) return engineText;
  const calories = parseNumberLine(engineText, /^🔥 (\S+) kcal$/m);
  const avgHr = parseNumberLine(engineText, /^❤️ avg (\S+) bpm$/m);
  const firstLine = engineText.split("\n", 1)[0];

  const outputs = new Set<string>();
  for (const c of candidates) {
    const w = c as Rec;
    if (`🏋️ ${(w.title as string) || "Workout"}` !== firstLine) continue; // cheap prefilter
    if (generateDescription(w, calories, avgHr) !== engineText) continue;
    const header = engineText.split("\n\n", 1)[0].split("\n");
    outputs.add(buildSetDescription(w, header));
  }
  // Two different workouts can only both match if their summaries are identical;
  // if their sets differ too, we can't know which one this is. Leave it alone.
  if (outputs.size === 1) return [...outputs][0];
  if (outputs.size > 1) console.warn("[set-description] ambiguous workout; kept engine description");
  return engineText;
}

/** Wrap the gateway so every `describe` writes the per-set description. */
export function withSetDescriptions(
  gateway: GarminGateway,
  candidates: () => Iterable<object>,
): GarminGateway {
  return {
    ...gateway,
    describe: (activityId, description) =>
      gateway.describe(activityId, rewriteDescription(description, candidates())),
  };
}

/**
 * Remember the workouts the engine stores in pending rows. The recovery retry
 * describes the workout saved there rather than one fetched from Hevy, so the
 * gateway wrapper needs to know about those as well.
 */
export function rememberPendingWorkouts<S extends SyncStore>(
  store: S,
  remember: (workout: Rec) => void,
): S {
  const keep = (payload: Rec | null | undefined) => {
    const w = payload?.workout;
    if (w && typeof w === "object") remember(w as Rec);
  };
  return {
    ...store,
    getPending: async (hevyId: string) => {
      const row = await store.getPending(hevyId);
      keep(row?.payload);
      return row;
    },
    claimPending: (hevyId: string, payload: Rec) => {
      keep(payload);
      return store.claimPending(hevyId, payload);
    },
  };
}
