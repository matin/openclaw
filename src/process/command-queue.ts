import {
  diagnosticLogger as diag,
  logLaneDequeue,
  logLaneEnqueue,
} from "../logging/diagnostic-runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CommandQueueEnqueueOptions } from "./command-queue.types.js";
import { CommandLane } from "./lanes.js";
/**
 * Dedicated error type thrown when a queued command is rejected because
 * its lane was cleared.  Callers that fire-and-forget enqueued tasks can
 * catch (or ignore) this specific type to avoid unhandled-rejection noise.
 */
export class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

/**
 * Dedicated error type thrown when an active command exceeds its caller-owned
 * lane timeout. The underlying task may still be unwinding, but the lane is
 * released so queued work is not blocked forever.
 */
export class CommandLaneTaskTimeoutError extends Error {
  constructor(lane: string, timeoutMs: number) {
    super(`Command lane "${lane}" task timed out after ${timeoutMs}ms`);
    this.name = "CommandLaneTaskTimeoutError";
  }
}

export function isCommandLaneTaskTimeoutError(err: unknown, lane?: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (!(err instanceof CommandLaneTaskTimeoutError || err.name === "CommandLaneTaskTimeoutError")) {
    return false;
  }
  return lane === undefined || err.message.includes(`Command lane "${lane}" task timed out`);
}

/**
 * Dedicated error type thrown when a new command is rejected because the
 * gateway is currently draining for restart.
 */
export class GatewayDrainingError extends Error {
  constructor() {
    super("Gateway is draining for restart; new tasks are not accepted");
    this.name = "GatewayDrainingError";
  }
}

// Minimal in-process queue to serialize command executions.
// Default lane ("main") preserves the existing behavior. Additional lanes allow
// low-risk parallelism (e.g. cron jobs) without interleaving stdin / logs for
// the main auto-reply workflow.

type QueueEntry = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  sequence: number;
  priority: number;
  warnAfterMs: number;
  queuedAheadAtEnqueue: number;
  activeAheadAtEnqueue: number;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type ActiveTaskInfo = {
  startedAtMs: number;
  progressAtMs: () => number | undefined;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  activeTaskIds: Set<number>;
  /**
   * Per-active-task metadata used by the stall-reclaim guard. Keyed by the same
   * task id stored in `activeTaskIds`. A slot with no finite `taskTimeoutMs`
   * cannot self-expire via `runQueueEntryTask`, so this lets `pump()` reclaim a
   * phantom slot whose underlying promise never settled (see #12 / tulgey#238).
   */
  activeTaskInfo: Map<number, ActiveTaskInfo>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
  /** Last time the silent "cannot dispatch" warn fired, for throttling. */
  lastBlockedWarnAtMs: number;
};

/**
 * Hard ceiling after which an active lane slot with no progress is treated as a
 * phantom and forcibly reclaimed so queued work can dispatch. This is the
 * belt-and-suspenders backstop for enqueues that carry no finite
 * `taskTimeoutMs` (e.g. the embedded-run session lane). 10 minutes is well
 * above any legitimate single agent turn; the stage-stall watchdog and the
 * per-task `taskTimeoutMs` fire long before this for runs that opt in.
 */
const LANE_SLOT_STALL_CEILING_MS = 10 * 60_000;

/** Minimum gap between throttled "cannot dispatch" warns per lane. */
const LANE_BLOCKED_WARN_THROTTLE_MS = 30_000;

export type CommandLaneSnapshot = {
  lane: string;
  queuedCount: number;
  activeCount: number;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
};

type ActiveTaskWaiter = {
  activeTaskIds: Set<number>;
  resolve: (value: { drained: boolean }) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

function isExpectedNonErrorLaneFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "LiveSessionModelSwitchError";
}

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

function getQueueState() {
  const state = resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
    gatewayDraining: false,
    lanes: new Map<string, LaneState>(),
    activeTaskWaiters: new Set<ActiveTaskWaiter>(),
    nextTaskId: 1,
    nextQueueSequence: 1,
  }));
  // Schema migration: the singleton may have been created by an older code
  // version (e.g. v2026.4.2) that did not include `activeTaskWaiters`.  After
  // a SIGUSR1 in-process restart the new code inherits the stale object via
  // `resolveGlobalSingleton` because the Symbol key already exists on
  // globalThis.  Patch the missing field so all downstream consumers see a
  // valid Set instead of `undefined`.
  if (!state.activeTaskWaiters) {
    state.activeTaskWaiters = new Set<ActiveTaskWaiter>();
  }
  if (!state.nextQueueSequence) {
    state.nextQueueSequence = 1;
  }
  let maxQueueSequence = state.nextQueueSequence - 1;
  for (const lane of state.lanes.values() as IterableIterator<
    LaneState & { activeTaskInfo?: Map<number, ActiveTaskInfo>; lastBlockedWarnAtMs?: number }
  >) {
    // Schema migration for lanes inherited from an older singleton that lacked
    // the stall-reclaim bookkeeping (pre-#12).
    if (!lane.activeTaskInfo) {
      lane.activeTaskInfo = new Map<number, ActiveTaskInfo>();
    }
    if (typeof lane.lastBlockedWarnAtMs !== "number") {
      lane.lastBlockedWarnAtMs = 0;
    }
    for (const [index, entry] of (
      lane.queue as Array<
        QueueEntry & {
          activeAheadAtEnqueue?: number;
          priority?: number;
          queuedAheadAtEnqueue?: number;
          sequence?: number;
        }
      >
    ).entries()) {
      if (typeof entry.priority !== "number") {
        entry.priority = 0;
      }
      if (typeof entry.sequence !== "number") {
        entry.sequence = state.nextQueueSequence++;
      } else {
        maxQueueSequence = Math.max(maxQueueSequence, entry.sequence);
      }
      if (typeof entry.queuedAheadAtEnqueue !== "number") {
        entry.queuedAheadAtEnqueue = index;
      }
      if (typeof entry.activeAheadAtEnqueue !== "number") {
        entry.activeAheadAtEnqueue = lane.activeTaskIds.size;
      }
    }
  }
  if (state.nextQueueSequence <= maxQueueSequence) {
    state.nextQueueSequence = maxQueueSequence + 1;
  }
  return state;
}

function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}

function getLaneDepth(state: LaneState): number {
  return state.queue.length + state.activeTaskIds.size;
}

function createCommandLaneSnapshot(state: LaneState): CommandLaneSnapshot {
  return {
    lane: state.lane,
    queuedCount: state.queue.length,
    activeCount: state.activeTaskIds.size,
    maxConcurrent: state.maxConcurrent,
    draining: state.draining,
    generation: state.generation,
  };
}

function getLaneState(lane: string): LaneState {
  const queueState = getQueueState();
  const existing = queueState.lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    queue: [],
    activeTaskIds: new Set(),
    activeTaskInfo: new Map(),
    maxConcurrent: 1,
    draining: false,
    generation: 0,
    lastBlockedWarnAtMs: 0,
  };
  queueState.lanes.set(lane, created);
  return created;
}

function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
  if (taskGeneration !== state.generation) {
    return false;
  }
  // The slot may already have been reclaimed (stall-reclaim) or cleared
  // (resetCommandLane within the same generation is impossible, but a sibling
  // reclaim is not). A late completion for a no-longer-active task must be a
  // no-op: it freed nothing, so it must not pump or wake waiters as if it had.
  if (!state.activeTaskIds.delete(taskId)) {
    return false;
  }
  state.activeTaskInfo.delete(taskId);
  return true;
}

/**
 * Reclaim any active slot whose underlying task has shown no progress for
 * longer than {@link LANE_SLOT_STALL_CEILING_MS}. The task's promise may still
 * be unsettled (a "phantom" slot), but the slot is freed so queued work can
 * dispatch. Only the stalled taskIds are removed from the active set, so
 * healthy sibling tasks on a multi-concurrency lane are untouched; the late
 * completion of a reclaimed task is rendered a no-op by completeTask's
 * membership check.
 *
 * Returns the number of slots reclaimed.
 */
function reclaimStalledSlots(state: LaneState, nowMs: number): number {
  if (state.activeTaskIds.size === 0) {
    return 0;
  }
  const stalled: number[] = [];
  for (const taskId of state.activeTaskIds) {
    const info = state.activeTaskInfo.get(taskId);
    // Missing info should not happen, but treat it as reclaimable rather than
    // letting an untracked slot wedge the lane forever.
    const lastProgressAtMs = info
      ? Math.max(info.startedAtMs, readProgressAtMs(info, state.lane))
      : 0;
    if (nowMs - lastProgressAtMs >= LANE_SLOT_STALL_CEILING_MS) {
      stalled.push(taskId);
    }
  }
  if (stalled.length === 0) {
    return 0;
  }
  for (const taskId of stalled) {
    state.activeTaskIds.delete(taskId);
    state.activeTaskInfo.delete(taskId);
  }
  diag.warn(
    `lane slot reclaimed: lane=${state.lane} reclaimed=${stalled.length} ` +
      `ceilingMs=${LANE_SLOT_STALL_CEILING_MS} active=${state.activeTaskIds.size} queued=${state.queue.length}`,
  );
  return stalled.length;
}

function readProgressAtMs(info: ActiveTaskInfo, lane: string): number {
  let value: number | undefined;
  try {
    value = info.progressAtMs();
  } catch (err) {
    diag.warn(`lane slot progress callback failed: lane=${lane} error="${String(err)}"`);
    return info.startedAtMs;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : info.startedAtMs;
}

function hasPendingActiveTasks(taskIds: Set<number>): boolean {
  const queueState = getQueueState();
  for (const state of queueState.lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      if (taskIds.has(taskId)) {
        return true;
      }
    }
  }
  return false;
}

function resolveActiveTaskWaiter(waiter: ActiveTaskWaiter, result: { drained: boolean }): void {
  const queueState = getQueueState();
  if (!queueState.activeTaskWaiters.delete(waiter)) {
    return;
  }
  if (waiter.timeout) {
    clearTimeout(waiter.timeout);
  }
  waiter.resolve(result);
}

function notifyActiveTaskWaiters(): void {
  const queueState = getQueueState();
  for (const waiter of Array.from(queueState.activeTaskWaiters)) {
    if (waiter.activeTaskIds.size === 0 || !hasPendingActiveTasks(waiter.activeTaskIds)) {
      resolveActiveTaskWaiter(waiter, { drained: true });
    }
  }
}

function normalizeTaskTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function resolveQueuePriority(priority: CommandQueueEnqueueOptions["priority"]): number {
  switch (priority) {
    case "foreground":
      return 1;
    case "background":
      return -1;
    default:
      return 0;
  }
}

function enqueueLaneEntry(state: LaneState, entry: QueueEntry): void {
  const insertAt = state.queue.findIndex(
    (queued) =>
      queued.priority < entry.priority ||
      (queued.priority === entry.priority && queued.sequence > entry.sequence),
  );
  entry.queuedAheadAtEnqueue = insertAt < 0 ? state.queue.length : insertAt;
  entry.activeAheadAtEnqueue = state.activeTaskIds.size;
  if (insertAt < 0) {
    state.queue.push(entry);
    return;
  }
  state.queue.splice(insertAt, 0, entry);
}

async function runQueueEntryTask(lane: string, entry: QueueEntry): Promise<unknown> {
  const taskPromise = Promise.resolve().then(entry.task);
  const taskTimeoutMs = normalizeTaskTimeoutMs(entry.taskTimeoutMs);
  if (taskTimeoutMs === undefined) {
    return await taskPromise;
  }

  const startedAtMs = Date.now();
  const readLastProgressAtMs = () => {
    let value: number | undefined;
    try {
      value = entry.taskTimeoutProgressAtMs?.();
    } catch (err) {
      diag.warn(`lane task timeout progress callback failed: lane=${lane} error="${String(err)}"`);
    }
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.max(startedAtMs, Math.floor(value))
      : startedAtMs;
  };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const armTimeout = () => {
      const elapsedMs = Math.max(0, Date.now() - readLastProgressAtMs());
      const remainingMs = taskTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        timedOut = true;
        reject(new CommandLaneTaskTimeoutError(lane, taskTimeoutMs));
        return;
      }
      timeoutHandle = setTimeout(armTimeout, remainingMs);
      timeoutHandle.unref?.();
    };
    armTimeout();
  });

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } catch (err) {
    if (timedOut) {
      void taskPromise.catch((lateErr: unknown) => {
        diag.warn(
          `lane task rejected after timeout: lane=${lane} timeoutMs=${taskTimeoutMs} error="${String(lateErr)}"`,
        );
      });
    }
    throw err;
  } finally {
    if (!timedOut && timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
      diag.warn(
        `drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`,
      );
    }
    return;
  }
  state.draining = true;

  const pump = () => {
    try {
      while (state.queue.length > 0) {
        if (state.activeTaskIds.size >= state.maxConcurrent) {
          // Lane appears saturated. Before silently giving up — the failure
          // mode behind tulgey#238 — try to reclaim phantom slots whose task
          // never settled and carried no finite timeout to self-expire.
          const reclaimed = reclaimStalledSlots(state, Date.now());
          if (reclaimed === 0 || state.activeTaskIds.size >= state.maxConcurrent) {
            // Genuinely saturated (or reclaim freed nothing usable). Emit a
            // throttled warn at the decision point that was previously silent,
            // so a wedged lane is observable in prod.
            const now = Date.now();
            if (now - state.lastBlockedWarnAtMs >= LANE_BLOCKED_WARN_THROTTLE_MS) {
              state.lastBlockedWarnAtMs = now;
              let oldestActiveAgeMs = 0;
              for (const info of state.activeTaskInfo.values()) {
                oldestActiveAgeMs = Math.max(oldestActiveAgeMs, now - info.startedAtMs);
              }
              diag.warn(
                `lane dispatch blocked: lane=${lane} active=${state.activeTaskIds.size} ` +
                  `maxConcurrent=${state.maxConcurrent} queued=${state.queue.length} ` +
                  `oldestActiveAgeMs=${oldestActiveAgeMs}`,
              );
            }
            break;
          }
        }
        const entry = state.queue.shift() as QueueEntry;
        const waitedMs = Date.now() - entry.enqueuedAt;
        if (waitedMs >= entry.warnAfterMs) {
          try {
            entry.onWait?.(waitedMs, entry.queuedAheadAtEnqueue);
          } catch (err) {
            diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
          }
          diag.warn(
            `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${entry.queuedAheadAtEnqueue} ` +
              `activeAhead=${entry.activeAheadAtEnqueue} activeNow=${state.activeTaskIds.size} queueBehind=${state.queue.length}`,
          );
        }
        logLaneDequeue(lane, waitedMs, state.queue.length);
        const taskId = getQueueState().nextTaskId++;
        const taskGeneration = state.generation;
        const startTime = Date.now();
        state.activeTaskIds.add(taskId);
        state.activeTaskInfo.set(taskId, {
          startedAtMs: startTime,
          progressAtMs: () => entry.taskTimeoutProgressAtMs?.(),
        });
        void (async () => {
          try {
            const result = await runQueueEntryTask(lane, entry);
            const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
            if (completedCurrentGeneration) {
              notifyActiveTaskWaiters();
              diag.debug(
                `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${state.queue.length}`,
              );
              pump();
            }
            entry.resolve(result);
          } catch (err) {
            const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
            const isProbeLane = lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
            if (!isProbeLane && !isExpectedNonErrorLaneFailure(err)) {
              diag.error(
                `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
              );
            } else if (!isProbeLane) {
              diag.debug(
                `lane task interrupted: lane=${lane} durationMs=${Date.now() - startTime} reason="${String(err)}"`,
              );
            }
            if (completedCurrentGeneration) {
              notifyActiveTaskWaiters();
              pump();
            }
            entry.reject(err);
          }
        })();
      }
    } finally {
      state.draining = false;
    }
  };

  pump();
}

/**
 * Mark gateway as draining for restart so new enqueues fail fast with
 * `GatewayDrainingError` instead of being silently killed on shutdown.
 */
export function markGatewayDraining(): void {
  getQueueState().gatewayDraining = true;
}

export function isGatewayDraining(): boolean {
  return getQueueState().gatewayDraining;
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = normalizeLane(lane);
  const state = getLaneState(cleaned);
  const isProbeLane = cleaned.startsWith("auth-probe:") || cleaned.startsWith("session:probe-");
  const minConcurrent = isProbeLane ? 1 : 0;
  state.maxConcurrent = Math.max(minConcurrent, Math.floor(maxConcurrent));
  if (state.maxConcurrent > 0) {
    drainLane(cleaned);
  }
}

export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
): Promise<T> {
  const queueState = getQueueState();
  if (queueState.gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }
  const cleaned = normalizeLane(lane);
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    enqueueLaneEntry(state, {
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      sequence: queueState.nextQueueSequence++,
      priority: resolveQueuePriority(opts?.priority),
      warnAfterMs,
      queuedAheadAtEnqueue: 0,
      activeAheadAtEnqueue: 0,
      taskTimeoutMs: normalizeTaskTimeoutMs(opts?.taskTimeoutMs),
      taskTimeoutProgressAtMs: opts?.taskTimeoutProgressAtMs,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, getLaneDepth(state));
    drainLane(cleaned);
  });
}

export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = normalizeLane(lane);
  const state = getQueueState().lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return getLaneDepth(state);
}

export function getCommandLaneSnapshot(lane: string = CommandLane.Main): CommandLaneSnapshot {
  const resolved = normalizeLane(lane);
  const state = getQueueState().lanes.get(resolved);
  if (!state) {
    return {
      lane: resolved,
      queuedCount: 0,
      activeCount: 0,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    };
  }
  return createCommandLaneSnapshot(state);
}

export function getCommandLaneSnapshots(): CommandLaneSnapshot[] {
  return Array.from(getQueueState().lanes.values(), createCommandLaneSnapshot).toSorted((a, b) =>
    a.lane.localeCompare(b.lane),
  );
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of getQueueState().lanes.values()) {
    total += getLaneDepth(s);
  }
  return total;
}

export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = normalizeLane(lane);
  const state = getQueueState().lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const removed = state.queue.length;
  const pending = state.queue.splice(0);
  for (const entry of pending) {
    entry.reject(new CommandLaneClearedError(cleaned));
  }
  return removed;
}

/**
 * Force a single lane back to idle and immediately pump any queued entries.
 * Used only by recovery paths after the owner has already attempted to abort
 * the active work; stale completions from the previous generation are ignored.
 */
export function resetCommandLane(lane: string = CommandLane.Main): number {
  const cleaned = normalizeLane(lane);
  const state = getQueueState().lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const released = state.activeTaskIds.size;
  state.generation += 1;
  state.activeTaskIds.clear();
  state.activeTaskInfo.clear();
  state.draining = false;
  if (state.queue.length > 0) {
    drainLane(cleaned);
  }
  notifyActiveTaskWaiters();
  return released;
}

/**
 * Test-only hard reset that discards all queue state, including preserved
 * queued work from previous generations. Use this when a suite needs an
 * isolated baseline across shared-worker runs.
 */
export function resetCommandQueueStateForTest(): void {
  const queueState = getQueueState();
  queueState.gatewayDraining = false;
  queueState.lanes.clear();
  for (const waiter of Array.from(queueState.activeTaskWaiters)) {
    resolveActiveTaskWaiter(waiter, { drained: true });
  }
  queueState.nextTaskId = 1;
  queueState.nextQueueSequence = 1;
}

/**
 * Reset all lane runtime state to idle. Used after SIGUSR1 in-process
 * restarts where interrupted tasks' finally blocks may not run, leaving
 * stale active task IDs that permanently block new work from draining.
 *
 * Bumps lane generation and clears execution counters so stale completions
 * from old in-flight tasks are ignored. Queued entries are intentionally
 * preserved — they represent pending user work that should still execute
 * after restart.
 *
 * After resetting, drains any lanes that still have queued entries so
 * preserved work is pumped immediately rather than waiting for a future
 * `enqueueCommandInLane()` call (which may never come).
 */
export function resetAllLanes(): void {
  const queueState = getQueueState();
  queueState.gatewayDraining = false;
  const lanesToDrain: string[] = [];
  for (const state of queueState.lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    state.activeTaskInfo.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  // Drain after the full reset pass so all lanes are in a clean state first.
  for (const lane of lanesToDrain) {
    drainLane(lane);
  }
  notifyActiveTaskWaiters();
}

/**
 * Returns the total number of actively executing tasks across all lanes
 * (excludes queued-but-not-started entries).
 */
export function getActiveTaskCount(): number {
  const queueState = getQueueState();
  let total = 0;
  for (const s of queueState.lanes.values()) {
    total += s.activeTaskIds.size;
  }
  return total;
}

/**
 * Wait for all currently active tasks across all lanes to finish.
 * Polls at a short interval; resolves when no tasks are active or
 * when `timeoutMs` elapses (whichever comes first). If no timeout is passed,
 * waits indefinitely for the active set captured at call time.
 *
 * New tasks enqueued after this call are ignored — only tasks that are
 * already executing are waited on.
 */
export function waitForActiveTasks(timeoutMs?: number): Promise<{ drained: boolean }> {
  const queueState = getQueueState();
  const activeAtStart = new Set<number>();
  for (const state of queueState.lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      activeAtStart.add(taskId);
    }
  }

  if (activeAtStart.size === 0) {
    return Promise.resolve({ drained: true });
  }
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    return Promise.resolve({ drained: false });
  }

  return new Promise((resolve) => {
    const waiter: ActiveTaskWaiter = {
      activeTaskIds: activeAtStart,
      resolve,
    };
    if (timeoutMs !== undefined) {
      waiter.timeout = setTimeout(() => {
        resolveActiveTaskWaiter(waiter, { drained: false });
      }, timeoutMs);
    }
    queueState.activeTaskWaiters.add(waiter);
    notifyActiveTaskWaiters();
  });
}
