import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { errorMessage, throwIfAborted } from "./errors.ts";

type AclMode = "inherit" | "copy";
interface AclRequest {
  readonly id: number;
  readonly mode: AclMode;
  readonly source: string;
  readonly target: string;
}
interface PendingReply {
  readonly request: AclRequest;
  readonly reply: PromiseWithResolvers<void>;
}

export const macosAclScript = fileURLToPath(new URL("../macos-acl.js", import.meta.url));
const sessions = new AsyncLocalStorage<MacosAclSession>();

export function currentMacosAclSession(): MacosAclSession | undefined {
  return sessions.getStore();
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
  #pending: PendingReply | undefined;
  #failure: unknown;
  #stderr = "";
  #stopping = false;

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
    return !this.#stopping;
  }

  request(request: AclRequest): Promise<void> {
    const reply: PromiseWithResolvers<void> = Promise.withResolvers();
    this.#pending = { request, reply };
    this.#child.stdin.write(`${JSON.stringify(request)}\n`);
    return reply.promise;
  }

  terminate(): void {
    this.#stop();
  }

  end(): Promise<void> {
    this.#stopping = true;
    this.#child.stdin.end();
    return this.closed;
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
    this.#failure ??= failure;
    if (!this.#stopping) {
      this.#stopping = true;
      this.#child.kill();
    }
  }

  #receive(line: string): void {
    // Once stopping, even a valid reply leaves its request pending until the child closes, so the
    // caller observes the abort or first failure and cleans up only after the helper exited.
    if (this.#stopping) {
      return;
    }
    const pending = this.#pending;
    const reply = parseReply(line);
    if (pending === undefined || reply === undefined || reply.id !== pending.request.id) {
      this.#stop(new Error(`unexpected output ${line}`));
      return;
    }
    this.#pending = undefined;
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
    this.#stopping = true;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) {
      return;
    }
    const status =
      signal === null ? `exited with code ${String(code)}` : `was stopped by ${signal}`;
    const failure = this.#failure === undefined ? [] : [errorMessage(this.#failure)];
    const details = [...failure, this.#stderr.trim()].filter((detail) => detail.length > 0);
    pending.reply.reject(
      new Error(
        `macOS ACL helper ${status} without a valid reply${details.length > 0 ? `: ${details.join("; ")}` : ""}`,
        this.#failure === undefined ? undefined : { cause: this.#failure },
      ),
    );
  }
}

/** Serves one editing batch's ACL transfers through at most one lazily started helper. */
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
    this.#process ??= await AclProcess.start();
    return this.#process;
  }
}
