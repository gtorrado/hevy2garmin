import { NextResponse, after } from "next/server";
import { acquireSyncLock } from "hevy2garmin";
import { syncOneWorkout } from "@/lib/sync-one";
import { getDb } from "@/lib/db";
import { bearerMatches } from "@/lib/bearer";
import { getGithubPat, getGithubRepo, triggerViaActions } from "@/lib/github";
import { postgresLockBackend } from "@/lib/sync-lock-store";
import {
  VERCEL_WEBHOOK_CONFIG,
  runStagedSync,
  startStagedSync,
  webhookRetryConfig,
  type AttemptOutcome,
} from "@/lib/webhook-retry";

// Runs a sync at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Room for the after-response merge attempts on Vercel (VERCEL_WEBHOOK_CONFIG).
// 60 s is allowed on every plan, with or without Fluid compute.
export const maxDuration = 60;

/**
 * POST /api/cron/webhook — the Hevy webhook, fired when a workout is saved.
 *
 * Mirrors the Python /api/cron/webhook: it MUST be authenticated with a Bearer
 * CRON_SECRET (Hevy is configured with that secret), and when CRON_SECRET is
 * unset there is no way to authenticate a caller, so it refuses with 503. Only
 * the workout id is taken from the body, to aim the sync at that workout; the
 * workout itself is read from the Hevy API, not from what the caller sent.
 *
 * After that, in order:
 *
 *   - GITHUB_PAT + GITHUB_REPO set: hand off to the GitHub Action.
 *   - On Vercel: answer at once (Hevy wants a 200 within 5 s), then in
 *     `after()` try a merge-only sync of that workout now and again 20 s later.
 *     It folds the sets into the watch's activity if that is on Garmin already,
 *     and never uploads; an unmatched workout is left to the scheduled sync,
 *     which uploads it after the grace period. (An inline sync with the grace
 *     period, the old behaviour, always deferred: the webhook fires as the
 *     workout ends.)
 *   - Anywhere else (a long-running `next start`): accept at once and run the
 *     staged merge-first sync in the background (see lib/webhook-retry.ts).
 */

type Sql = ReturnType<typeof getDb>;

/** Hevy's body is `{ "workoutId": "<uuid>" }`. Anything else: no target. */
async function webhookWorkoutId(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.json()) as { workoutId?: unknown } | null;
    const id = body?.workoutId;
    return typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** One staged attempt, under the same lock the scheduled sync takes. */
function stagedAttempt(sql: Sql) {
  return async ({ mergeOnly, targetHevyId }: { mergeOnly: boolean; targetHevyId?: string }): Promise<AttemptOutcome> => {
    const lock = await acquireSyncLock({ backend: postgresLockBackend(sql), key: "sync" });
    if (!lock) return { busy: true };
    try {
      // Merge-only stands in for the grace period on the early attempts. The
      // grace flag is still passed: an engine that predates merge-only ignores
      // `mergeOnly`, and with the grace check it defers instead of uploading.
      const result = await syncOneWorkout(sql, {
        dryRun: false,
        respectGrace: mergeOnly,
        mergeOnly,
        ...(targetHevyId ? { targetHevyId } : {}),
      });
      return { busy: false, result };
    } finally {
      // A failed release must not turn a finished sync into a thrown attempt,
      // which the runner would retry. The lock goes stale on its own.
      await lock.release().catch((err) => console.error("[webhook] lock release failed:", err));
    }
  };
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook not configured: CRON_SECRET is unset." },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Settings row first, GITHUB_PAT fallback (#458). The DB handle may be unavailable here; env still works.
  let sqlForPat: ReturnType<typeof getDb> | null = null;
  try { sqlForPat = getDb(); } catch { sqlForPat = null; }
  const pat = await getGithubPat(sqlForPat);
  const repo = getGithubRepo();
  if (pat && repo) {
    try {
      const ok = await triggerViaActions(pat, repo);
      return NextResponse.json({ ok, mode: "dispatch", triggered: ok }, { status: ok ? 200 : 502 });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error }, { status: 502 });
    }
  }

  let sql: Sql;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  if (process.env.VERCEL) {
    const targetHevyId = await webhookWorkoutId(request);
    after(async () => {
      await runStagedSync(VERCEL_WEBHOOK_CONFIG, {
        attempt: stagedAttempt(sql),
        mergeOnlyAlways: true,
        targetHevyId,
      });
    });
    return NextResponse.json({ ok: true, mode: "after", status: "accepted" });
  }

  // Hevy wants a quick 200, and a throttled webhook still gets one, so Hevy
  // does not retry into the same wall.
  const config = webhookRetryConfig();
  const started = startStagedSync(config, { attempt: stagedAttempt(sql) });
  if (!started.accepted) {
    console.warn(
      `[webhook] throttled: ${started.inFlight} staged syncs already running; they and the scheduled sync will pick this workout up`,
    );
    return NextResponse.json({ ok: true, mode: "staged", status: "throttled", inFlight: started.inFlight });
  }
  return NextResponse.json({
    ok: true,
    mode: "staged",
    status: "accepted",
    delaySeconds: config.delaySeconds,
    maxAttempts: config.maxAttempts,
  });
}
