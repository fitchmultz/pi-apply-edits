import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { errorMessage, throwIfAborted } from "./errors.ts";
import type { AclMode, AclRequest } from "./acl-protocol.ts";
interface PendingReply {
  readonly request: AclRequest;
  readonly reply: PromiseWithResolvers<void>;
}

type AclProcessState =
  | { readonly kind: "ready" }
  | { readonly kind: "awaiting"; readonly pending: PendingReply }
  | {
      readonly kind: "stopping";
      readonly pending: PendingReply | undefined;
      readonly firstFailure: unknown;
    }
  | { readonly kind: "closed" };

export const macosAclScript = fileURLToPath(new URL("../macos-acl.js", import.meta.url));
const sessions = new AsyncLocalStorage<MacosAclSession>();
// Owners that keep a finished batch's helper for the next batch, and that idle helper.
const retainers = new Set<object>();
let idleHelper: AclProcess | undefined;

export function currentMacosAclSession(): MacosAclSession | undefined {
  return sessions.getStore();
}

/** Keeps one finished batch's helper for the next batch until `owner` releases it. */
export function retainMacosAclHelper(owner: object): void {
  retainers.add(owner);
}

/** Ends the idle helper once no owner retains it. */
export async function releaseMacosAclHelper(owner: object): Promise<void> {
  retainers.delete(owner);
  if (retainers.size > 0) {
    return;
  }
  const helper = idleHelper;
  idleHelper = undefined;
  await helper?.end();
}

function ignoreSettlement(): void {
  // Serialization only orders requests; each caller receives its own outcome.
}

function parseReply(line: string): { readonly id: unknown; readonly error?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return;
  }
  if (!("error" in value)) {
    return { id: value.id };
  }
  return typeof value.error === "string" ? { id: value.id, error: value.error } : undefined;
}

/** One osascript child answering one request at a time over private pipes. */
class AclProcess {
  readonly closed: Promise<void>;
  readonly #child: ChildProcessWithoutNullStreams = spawn("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    macosAclScript,
  ]);
  #state: AclProcessState = { kind: "ready" };
  #stderr = "";

  private constructor() {
    const exit: PromiseWithResolvers<void> = Promise.withResolvers();
    this.closed = exit.promise;
    this.#child.once("close", (code, signal) => {
      this.#settleExit(code, signal);
      exit.resolve();
    });
  }

  static async start(): Promise<AclProcess> {
    const helper = new AclProcess();
    try {
      await once(helper.#child, "spawn");
    } catch (error) {
      // Node still emits 'close' after a failed spawn, whose stdio may be absent. Kill triggers
      // start only after 'spawn': Node 24.0 forwards kill() without a pid to kill(0, signal).
      await helper.closed;
      throw error;
    }
    helper.#listen();
    return helper;
  }

  get usable(): boolean {
    return this.#state.kind === "ready" || this.#state.kind === "awaiting";
  }

  request(request: AclRequest): Promise<void> {
    const reply: PromiseWithResolvers<void> = Promise.withResolvers();
    this.#state = { kind: "awaiting", pending: { request, reply } };
    this.#child.stdin.write(`${JSON.stringify(request)}\n`);
    return reply.promise;
  }

  terminate(): void {
    this.#stop();
  }

  end(): Promise<void> {
    // Waiting for the exit keeps the host running until the helper closes.
    this.reference(true);
    const state = this.#state;
    if (state.kind === "ready" || state.kind === "awaiting") {
      this.#state = {
        kind: "stopping",
        pending: state.kind === "awaiting" ? state.pending : undefined,
        firstFailure: undefined,
      };
    }
    this.#child.stdin.end();
    return this.closed;
  }

  /** An idle helper must not keep the host running; it exits when the host closes its stdin. */
  reference(held: boolean): void {
    const pipes = [this.#child.stdin, this.#child.stdout, this.#child.stderr].filter(
      (pipe): pipe is Socket => pipe instanceof Socket,
    );
    for (const handle of [this.#child, ...pipes]) {
      if (held) {
        handle.ref();
      } else {
        handle.unref();
      }
    }
  }

  #listen(): void {
    const stop = (error: unknown): void => {
      this.#stop(error);
    };
    this.#child.on("error", stop);
    this.#child.stdin.on("error", stop);
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (text: string) => {
      this.#stderr += text;
    });
    this.#child.stderr.on("error", stop);
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
      .on("line", (line) => {
        this.#receive(line);
      })
      .on("error", stop);
  }

  #stop(failure?: unknown): void {
    const state = this.#state;
    if (state.kind === "closed") {
      return;
    }
    if (state.kind === "stopping") {
      this.#state = { ...state, firstFailure: state.firstFailure ?? failure };
      return;
    }
    this.#state = {
      kind: "stopping",
      pending: state.kind === "awaiting" ? state.pending : undefined,
      firstFailure: failure,
    };
    this.#child.kill();
  }

  #receive(line: string): void {
    // Once stopping, even a valid reply leaves its request pending until the child closes, so the
    // caller observes the abort or first failure and cleans up only after the helper exited.
    const state = this.#state;
    if (state.kind === "stopping" || state.kind === "closed") {
      return;
    }
    const pending = state.kind === "awaiting" ? state.pending : undefined;
    const reply = parseReply(line);
    if (pending === undefined || reply === undefined || reply.id !== pending.request.id) {
      this.#stop(new Error(`unexpected output ${line}`));
      return;
    }
    this.#state = { kind: "ready" };
    if (reply.error === undefined) {
      pending.reply.resolve();
      return;
    }
    const { mode, source, target } = pending.request;
    pending.reply.reject(
      new Error(`macOS ACL ${mode} from ${source} to ${target} failed: ${reply.error}`),
    );
  }

  // Stopped or failed requests settle only after the child closed, so callers clean up afterward.
  // The first stream, process or protocol error stays the cause beside the helper's own report.
  #settleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const state = this.#state;
    this.#state = { kind: "closed" };
    const pending =
      state.kind === "awaiting" || state.kind === "stopping" ? state.pending : undefined;
    if (pending === undefined) {
      return;
    }
    const firstFailure = state.kind === "stopping" ? state.firstFailure : undefined;
    const status =
      signal === null ? `exited with code ${String(code)}` : `was stopped by ${signal}`;
    const failure = firstFailure === undefined ? [] : [errorMessage(firstFailure)];
    const details = [...failure, this.#stderr.trim()].filter((detail) => detail.length > 0);
    pending.reply.reject(
      new Error(
        `macOS ACL helper ${status} without a valid reply${details.length > 0 ? `: ${details.join("; ")}` : ""}`,
        firstFailure === undefined ? undefined : { cause: firstFailure },
      ),
    );
  }
}

/** Takes the idle helper unless it exited while idle, or starts one. */
async function takeHelper(): Promise<AclProcess> {
  const helper = idleHelper;
  idleHelper = undefined;
  if (helper?.usable === true) {
    helper.reference(true);
    return helper;
  }
  await helper?.closed;
  return AclProcess.start();
}

/** Serves one editing batch's ACL transfers through at most one helper, held exclusively. */
export class MacosAclSession {
  #process: AclProcess | undefined;
  #nextId = 1;
  #tail: Promise<void> = Promise.resolve();

  /** Scope only internal filesystem work; callbacks outside run never see this session. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    return process.platform === "darwin" ? sessions.run(this, operation) : operation();
  }

  transfer(mode: AclMode, source: string, target: string, signal?: AbortSignal): Promise<void> {
    const result = this.#tail.then(async () =>
      this.#send({ id: this.#nextId++, mode, source, target }, signal),
    );
    this.#tail = result.then(ignoreSettlement, ignoreSettlement);
    return result;
  }

  async close(): Promise<void> {
    await this.#tail;
    const helper = this.#process;
    this.#process = undefined;
    if (helper?.usable === true && retainers.size > 0 && idleHelper === undefined) {
      helper.reference(false);
      idleHelper = helper;
      return;
    }
    await helper?.end();
  }

  async #send(request: AclRequest, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const helper = await this.#live();
    throwIfAborted(signal);
    const terminate = (): void => {
      helper.terminate();
    };
    const reply = helper.request(request);
    signal?.addEventListener("abort", terminate, { once: true });
    try {
      await reply;
    } catch (error) {
      // A lost reply is never replayed: its private target is discarded by the caller.
      throwIfAborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener("abort", terminate);
    }
  }

  async #live(): Promise<AclProcess> {
    if (this.#process !== undefined && !this.#process.usable) {
      await this.#process.closed;
      this.#process = undefined;
    }
    this.#process ??= await takeHelper();
    return this.#process;
  }
}
