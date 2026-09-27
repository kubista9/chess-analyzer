import type { PositionEval } from "../../shared/types.js";
import { analysePosition, replayUci, type PositionRequest, type SearchEngine } from "./analysePosition.js";
import { ENGINE_PROTOCOL, type EngineProtocol } from "./protocol.js";
import { EngineCrashedError, EngineTimeoutError } from "./uci.js";

// A pool of N single-thread engine workers with two priorities.
// - Work comes in groups (usually one game: its positions in order). A worker keeps a group
//   and runs its positions on one engine, so the hash stays warm; it sends ucinewgame only
//   when it switches groups.
// - "interactive" groups (review, alternatives, drill checks) run before "backfill" groups.
//   The queue is checked between positions: a worker on a backfill game hands the rest of it
//   back to the front of the backfill queue when interactive work is waiting.
// - A crashed engine is respawned and the position retried once, then the position (and the
//   rest of its group) fails with the engine's error. Nothing hangs.
// - Identical requests that are queued or running share one search (unless the new request
//   is interactive and the existing one is only backfill, which would make it wait).

export type Priority = "interactive" | "backfill";

export interface PoolEngine extends SearchEngine {
  readonly alive: boolean;
  readonly idName: string;
  newGame(): Promise<void>;
  close(): Promise<void>;
  kill(): void;
}

export interface EnginePoolOptions {
  size: number;
  spawn: () => Promise<PoolEngine>;
  protocol?: EngineProtocol;
}

export interface GameOptions {
  priority: Priority;
  onProgress?: (done: number, total: number) => void;
}

export interface PoolStats {
  size: number;
  engines: number;
  busy: number;
  queued: Record<Priority, number>;
}

interface Task {
  key: string | null;
  groupId: string;
  priority: Priority;
  request: PositionRequest;
  attempts: number;
  promise: Promise<PositionEval>;
  resolve: (value: PositionEval) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface Group {
  id: string;
  priority: Priority;
  tasks: Task[];
  failed: Error | null;
}

interface Worker {
  engine: PoolEngine | null;
  group: Group | null;
  lastGroupId: string | null;
  running: boolean;
}

export class EnginePoolClosedError extends Error {
  constructor() {
    super("The engine pool was closed");
    this.name = "EnginePoolClosedError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof EngineCrashedError || error instanceof EngineTimeoutError;
}

export class EnginePool {
  private readonly queues: Record<Priority, Group[]> = { interactive: [], backfill: [] };
  private readonly workers: Worker[];
  private readonly inflight = new Map<string, Task>();
  private readonly protocol: EngineProtocol;
  private closed = false;
  private singles = 0;

  constructor(private readonly options: EnginePoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new Error(`Engine pool size must be a positive integer, got ${options.size}`);
    }
    this.protocol = options.protocol ?? ENGINE_PROTOCOL;
    this.workers = Array.from({ length: options.size }, () => ({ engine: null, group: null, lastGroupId: null, running: false }));
  }

  /**
   * Analyses a game's positions in order on one worker. Resolves with one eval per request;
   * rejects with the first failure (the group's remaining positions are dropped).
   */
  analyseGame(groupId: string, requests: readonly PositionRequest[], options: GameOptions): Promise<PositionEval[]> {
    if (this.closed) {
      return Promise.reject(new EnginePoolClosedError());
    }
    const group: Group = { id: groupId, priority: options.priority, tasks: [], failed: null };
    let promises: Promise<PositionEval>[];
    try {
      promises = requests.map((request) => this.taskFor(group, request).promise);
    } catch (error) {
      return Promise.reject(error);
    }
    if (group.tasks.length) {
      this.queues[group.priority].push(group);
      this.pump();
    }

    let done = 0;
    options.onProgress?.(0, requests.length);
    for (const promise of promises) {
      promise.then(
        () => options.onProgress?.(++done, requests.length),
        () => undefined
      );
    }

    return Promise.all(promises).catch((error: Error) => {
      this.failGroup(group, error);
      throw error;
    });
  }

  /** Analyses one position as its own group. */
  analyse(request: PositionRequest, priority: Priority): Promise<PositionEval> {
    this.singles += 1;
    return this.analyseGame(`position:${this.singles}`, [request], { priority }).then((results) => results[0]);
  }

  /** The `id name` of the pool's engine (spawns one idle engine if none is running yet). */
  async engineIdName(): Promise<string> {
    const existing = this.workers.find((worker) => worker.engine?.alive);
    if (existing?.engine) {
      return existing.engine.idName;
    }
    const engine = await this.options.spawn();
    const slot = this.workers.find((worker) => !worker.engine && !worker.running);
    if (slot && !this.closed) {
      slot.engine = engine;
      slot.lastGroupId = null;
    } else {
      await engine.close();
    }
    return engine.idName;
  }

  stats(): PoolStats {
    const count = (priority: Priority) =>
      this.queues[priority].reduce((sum, group) => sum + group.tasks.length, 0) +
      this.workers.reduce((sum, worker) => sum + (worker.group?.priority === priority ? worker.group.tasks.length : 0), 0);
    return {
      size: this.options.size,
      engines: this.workers.filter((worker) => worker.engine?.alive).length,
      busy: this.workers.filter((worker) => worker.running).length,
      queued: { interactive: count("interactive"), backfill: count("backfill") }
    };
  }

  /** Rejects all queued work and closes every engine. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const closedError = new EnginePoolClosedError();
    for (const group of [...this.queues.interactive, ...this.queues.backfill, ...this.workers.map((worker) => worker.group)]) {
      if (group) {
        this.failGroup(group, closedError);
      }
    }
    this.queues.interactive = [];
    this.queues.backfill = [];
    await Promise.all(
      this.workers.map(async (worker) => {
        const engine = worker.engine;
        worker.engine = null;
        await engine?.close();
      })
    );
  }

  /** Kills every engine at once (for process exit, where nothing async runs). */
  killAll(): void {
    this.closed = true;
    for (const worker of this.workers) {
      worker.engine?.kill();
    }
  }

  private taskFor(group: Group, request: PositionRequest): Task {
    // Replaying validates the moves up front and gives the dedupe key.
    const { epd } = replayUci(request.moves);
    const key = request.cached ? null : `${request.tier}|${epd}|${[...new Set(request.played ?? [])].sort().join(",")}`;
    const existing = key ? this.inflight.get(key) : undefined;
    if (existing && (existing.priority === "interactive" || group.priority === "backfill")) {
      return existing;
    }

    let resolve!: (value: PositionEval) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PositionEval>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Rejections are handled through the group; avoid unhandled-rejection noise for dropped tasks.
    promise.catch(() => undefined);
    const task: Task = { key, groupId: group.id, priority: group.priority, request, attempts: 0, promise, resolve, reject, settled: false };
    if (key) {
      this.inflight.set(key, task);
    }
    group.tasks.push(task);
    return task;
  }

  private settle(task: Task, outcome: { value: PositionEval } | { error: Error }): void {
    if (task.settled) {
      return;
    }
    task.settled = true;
    if (task.key && this.inflight.get(task.key) === task) {
      this.inflight.delete(task.key);
    }
    if ("value" in outcome) {
      task.resolve(outcome.value);
    } else {
      task.reject(outcome.error);
    }
  }

  private failGroup(group: Group, error: Error): void {
    group.failed ??= error;
    for (const task of group.tasks.splice(0)) {
      this.settle(task, { error });
    }
  }

  private hasQueued(): boolean {
    return this.queues.interactive.length > 0 || this.queues.backfill.length > 0;
  }

  private pump(): void {
    for (const worker of this.workers) {
      if (this.closed || !this.hasQueued()) {
        return;
      }
      if (!worker.running) {
        void this.runWorker(worker);
      }
    }
  }

  /** The next position for a worker: its own group, unless interactive work waits for a backfill game. */
  private nextTask(worker: Worker): Task | null {
    let group = worker.group;
    if (group && (group.failed || !group.tasks.length)) {
      group = null;
    }
    if (group && group.priority === "backfill" && this.queues.interactive.length) {
      this.queues.backfill.unshift(group);
      group = null;
    }
    while (!group) {
      const next = this.queues.interactive.shift() ?? this.queues.backfill.shift();
      if (!next) {
        worker.group = null;
        return null;
      }
      if (!next.failed && next.tasks.length) {
        group = next;
      }
    }
    worker.group = group;
    return group.tasks.shift()!;
  }

  private async runWorker(worker: Worker): Promise<void> {
    worker.running = true;
    try {
      for (let task = this.nextTask(worker); task && !this.closed; task = this.nextTask(worker)) {
        await this.runTask(worker, task);
      }
    } finally {
      worker.running = false;
      worker.group = null;
    }
    this.pump();
  }

  private async runTask(worker: Worker, task: Task): Promise<void> {
    try {
      if (!worker.engine || !worker.engine.alive) {
        worker.engine?.kill();
        worker.engine = null;
        worker.engine = await this.options.spawn();
        worker.lastGroupId = null;
        if (this.closed) {
          await worker.engine.close();
          throw new EnginePoolClosedError();
        }
      }
      if (worker.lastGroupId !== task.groupId) {
        await worker.engine.newGame();
        worker.lastGroupId = task.groupId;
      }
      const value = await analysePosition(worker.engine, task.request, this.protocol);
      this.settle(task, { value });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (worker.engine && !worker.engine.alive) {
        worker.engine = null;
      }
      if (!this.closed && isRetryable(error) && task.attempts < 1 && worker.group && !worker.group.failed) {
        task.attempts += 1;
        worker.lastGroupId = null;
        worker.group.tasks.unshift(task);
        return;
      }
      this.settle(task, { error: this.closed ? new EnginePoolClosedError() : error });
      if (worker.group) {
        this.failGroup(worker.group, error);
      }
    }
  }
}
