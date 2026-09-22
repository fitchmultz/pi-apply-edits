import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SourceInfo } from "@earendil-works/pi-coding-agent";
import { supportsExistingFileReplacement } from "../src/file-system.ts";
import { createEditingTools } from "../src/tools.ts";

export default function editingExtension(pi: ExtensionAPI): void {
  let nativeContext: ExtensionContext | undefined;
  pi.registerFlag("apply-edits-with-builtins", {
    type: "boolean", default: false,
    description: "Keep Pi's built-in edit and write tools active alongside the editing tools",
  });
  const tools = createEditingTools(() => {
    if (!nativeContext) throw new Error("Editing session context is not initialized. Start a session or prompt first.");
    return resolveExecutionCwd(pi, nativeContext);
  });
  for (const tool of tools) pi.registerTool(tool);
  const ownsTool = (name: string) => tools.some((tool) => tool.name === name &&
    pi.getAllTools().find((registered) => registered.name === name)?.parameters === tool.parameters);

  const start = async (ctx: ExtensionContext) => {
    nativeContext = ctx;
    const active = pi.getActiveTools();
    if (!active.some((name) => name !== "preview_patch" && ownsTool(name)) || keepBuiltins(pi)) return;
    if (!(await supportsExistingFileReplacement())) return;
    const replaceable = pi.getAllTools().filter((item) =>
      (item.name === "edit" || item.name === "write") &&
      (item.sourceInfo.source === "builtin" || isDirectoryOwner(item.sourceInfo)),
    ).map((item) => item.name);
    pi.setActiveTools(active.filter((name) => !replaceable.includes(name)));
  };
  pi.on("session_start", async (_event, ctx) => { await start(ctx); });
  pi.on("before_agent_start", async (_event, ctx) => {
    // Bare SDK prompts do not emit session_start.
    if (!nativeContext) await start(ctx);
    else nativeContext = ctx;
  });
  pi.on("tool_result", (event) => {
    if (ownsTool(event.toolName) && isRecord(event.details) && typeof event.details.error === "string") {
      return { isError: true };
    }
    return undefined;
  });
  pi.on("session_before_compact", (event) => {
    for (const message of [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]) {
      if (message.role !== "toolResult" || !tools.some((tool) => tool.name === message.toolName)) continue;
      const details = message.details;
      if (!isRecord(details) || details.preview === true || !Array.isArray(details.modifiedFiles)) continue;
      // Partial-error receipts still contain completed mutations.
      for (const path of details.modifiedFiles) {
        if (typeof path === "string" && isAbsolute(path)) event.preparation.fileOps.edited.add(path);
      }
    }
  });
}

function resolveExecutionCwd(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const request: { sessionManager: ExtensionContext["sessionManager"]; result?: unknown } = { sessionManager: ctx.sessionManager };
  pi.events.emit("pi-change-working-dir:resolve-execution-cwd", request);
  const result = request.result;
  if (result !== undefined) {
    const invalid = "pi-change-working-dir returned an invalid execution directory. Update the extension and restart Pi.";
    if (!isRecord(result)) throw new Error(invalid);
    if (result.error !== undefined) {
      throw new Error(typeof result.error === "string" && result.error.length > 0 ? result.error : invalid);
    }
    if (typeof result.cwd !== "string" || !isAbsolute(result.cwd) || result.cwd.includes("\0")) throw new Error(invalid);
    return result.cwd;
  }
  if (pi.getAllTools().some((tool) => tool.name === "change_dir" && isDirectoryOwner(tool.sourceInfo)) ||
    pi.getCommands().some((command) => /^cwd(?::\d+)?$/.test(command.name) && isDirectoryOwner(command.sourceInfo))) {
    throw new Error("Update pi-change-working-dir and restart Pi before using editing tools; the loaded owner cannot resolve its execution directory.");
  }
  return ctx.cwd;
}

function isDirectoryOwner(source: SourceInfo): boolean {
  if (/^(?:npm:pi-change-working-dir|git:github\.com\/fitchmultz\/pi-change-working-dir(?:\.git)?)(?:@.+)?$/.test(source.source)) return true;
  const directories = [source.baseDir, isAbsolute(source.path) ? dirname(source.path) : undefined];
  return directories.some((directory) => {
    if (!directory || !isAbsolute(directory)) return false;
    try { return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === "pi-change-working-dir"; }
    catch { return false; }
  });
}

function keepBuiltins(pi: ExtensionAPI): boolean {
  return pi.getFlag("apply-edits-with-builtins") === true ||
    ["1", "true", "yes", "on"].includes((process.env.PI_APPLY_EDITS_KEEP_BUILTINS ?? "").trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
