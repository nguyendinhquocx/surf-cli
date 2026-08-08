import { createRequire } from "node:module";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const { openClientTransport } = require("../native/client-transport.cjs") as {
  openClientTransport(endpoint: SurfEndpoint, options?: { requestTimeoutMs?: number }): Promise<{
    request(message: Record<string, unknown>, timeoutMs?: number, transferPlan?: Record<string, unknown>): Promise<Record<string, unknown>>;
    close(): Promise<void>;
  }>;
};
const { selectEndpoint } = require("../native/endpoint.cjs") as {
  selectEndpoint(args: string[], env?: Record<string, string | undefined>): { endpoint: SurfEndpoint };
};
const { resolveRequestDeadlineMs } = require("../native/host-sessions.cjs") as {
  resolveRequestDeadlineMs(tool: string, args: Record<string, unknown>): number;
};
const { prepareRemoteTool, validateLocalToolPaths } = require("../native/file-transfer.cjs") as {
  prepareRemoteTool(tool: string, args: Record<string, unknown>): { args: Record<string, unknown>; uploads?: unknown[]; downloads?: unknown[]; pathRefs?: unknown[] };
  validateLocalToolPaths(tool: string, args: Record<string, unknown>): Record<string, unknown>;
};

const MAX_OUTPUT_CHARS = 20_000;
const ORACLE_ACTIVE_STATES = new Set(["created", "dispatched", "awaiting"]);
const ORACLE_TERMINAL_STATES = new Set(["captured", "failed"]);
const ORACLE_FINISHED_CHANNEL = "surf-oracle:finished";
const BACKGROUND_WORK_PROTOCOL_VERSION = 1;
const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";
const BACKGROUND_WORK_MODULE_SPECIFIER = "pi-subagents/background-work";

type Pi = {
  registerTool(tool: Record<string, unknown>): void;
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: unknown) => void | Promise<void>): void;
  events?: { emit(event: string, data: unknown): void };
};

type SurfEndpoint = { kind?: string };

type ToolResult = { content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError?: boolean };

type BackgroundWorkProvider = {
  name: string;
  wakeChannels: string[];
  listActiveWork(): Array<{ id: string; sessionId: string }>;
};

type RegisterBackgroundWorkProvider = (provider: BackgroundWorkProvider) => () => void;

type BackgroundWorkModule = {
  registerBackgroundWorkProvider?: unknown;
};

type BackgroundWorkRegistry = {
  version: typeof BACKGROUND_WORK_PROTOCOL_VERSION;
  providers: Map<string, BackgroundWorkProvider>;
};

function textResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const bounded = text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Surf output truncated at ${MAX_OUTPUT_CHARS} characters]`
    : text;
  return { content: [{ type: "text", text: bounded }], ...(isError ? { isError: true } : {}) };
}

export function resultFromHost(response: Record<string, unknown>): ToolResult {
  const error = response.error as { content?: Array<{ text?: string }> } | undefined;
  if (error) return textResult(error.content?.map((item) => item.text ?? "").join("\n") || "Surf request failed", true);
  const result = response.result as { content?: ToolResult["content"] } | undefined;
  if (!result?.content) return textResult(result ?? "OK");
  const text = result.content.find((item) => item.type === "text")?.text;
  let details: unknown;
  try {
    details = text ? JSON.parse(text) : undefined;
  } catch {
    details = undefined;
  }
  const content = result.content.map((item) => item.type === "text" && item.text && item.text.length > MAX_OUTPUT_CHARS
    ? { ...item, text: `${item.text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Surf output truncated at ${MAX_OUTPUT_CHARS} characters]` }
    : item);
  return { content, details };
}

export function createToolRequest(tool: string, args: Record<string, unknown>, tabId?: number) {
  return {
    type: "tool_request",
    method: "execute_tool",
    params: { tool, args, ...(tabId === undefined ? {} : { tabId }) },
    id: `pi-surf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

function prepareRequest(endpoint: SurfEndpoint, tool: string, args: Record<string, unknown>) {
  if (endpoint.kind === "remote") return prepareRemoteTool(tool, args);
  return { args: validateLocalToolPaths(tool, args), uploads: [], downloads: [], pathRefs: [] };
}

export async function requestSurf(tool: string, args: Record<string, unknown>, tabId?: number): Promise<ToolResult> {
  const { endpoint } = selectEndpoint([], process.env);
  const timeoutMs = resolveRequestDeadlineMs(tool, args);
  const transport = await openClientTransport(endpoint, { requestTimeoutMs: timeoutMs });
  try {
    const prepared = prepareRequest(endpoint, tool, args);
    const response = await transport.request(createToolRequest(tool, prepared.args, tabId), timeoutMs, prepared);
    return resultFromHost(response);
  } finally {
    await transport.close();
  }
}

export function surfRequest(tool: string, args: Record<string, unknown>, tabId?: number) {
  return requestSurf(tool, args, tabId);
}

export function registerGlobalBackgroundProvider(provider: BackgroundWorkProvider): () => void {
  const key = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[key];
  let registry: BackgroundWorkRegistry;

  if (existing === undefined) {
    registry = { version: BACKGROUND_WORK_PROTOCOL_VERSION, providers: new Map() };
    globalObject[key] = registry;
  } else if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    (existing as Partial<BackgroundWorkRegistry>).version === BACKGROUND_WORK_PROTOCOL_VERSION &&
    (existing as Partial<BackgroundWorkRegistry>).providers instanceof Map
  ) {
    registry = existing as BackgroundWorkRegistry;
  } else {
    throw new Error(`Unsupported background-work registry at Symbol.for("${BACKGROUND_WORK_REGISTRY_KEY}").`);
  }

  registry.providers.set(provider.name, provider);
  return () => {
    if (registry.providers.get(provider.name) === provider) registry.providers.delete(provider.name);
  };
}

export async function resolveBackgroundWorkRegister(
  loadModule: () => Promise<BackgroundWorkModule> = () => import(BACKGROUND_WORK_MODULE_SPECIFIER) as Promise<BackgroundWorkModule>,
): Promise<RegisterBackgroundWorkProvider> {
  try {
    const module = await loadModule();
    if (typeof module.registerBackgroundWorkProvider === "function") {
      return module.registerBackgroundWorkProvider as RegisterBackgroundWorkProvider;
    }
  } catch {
    // The Pi bridge is optional. Surf also runs in other coding-agent harnesses and as a direct CLI.
  }
  return registerGlobalBackgroundProvider;
}

export function registerOptionalBackgroundProvider(sessionId: string, jobIds: Set<string>, listJobs: () => Array<{ id: string; state: string }>, register: RegisterBackgroundWorkProvider) {
  return register({
    name: "surf-oracle",
    wakeChannels: [ORACLE_FINISHED_CHANNEL],
    listActiveWork: () => listJobs()
      .filter((job) => jobIds.has(job.id) && ORACLE_ACTIVE_STATES.has(job.state))
      .map((job) => ({ id: job.id, sessionId })),
  });
}

export function rememberOracleJobForSession(jobIds: Set<string>, jobId: unknown, requestGeneration: number, currentGeneration: number, sessionActive: boolean): boolean {
  if (typeof jobId !== "string" || !sessionActive || requestGeneration !== currentGeneration) return false;
  jobIds.add(jobId);
  return true;
}

export function emitOracleFinished(pi: Pi, job: unknown): boolean {
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  const { id, state } = job as { id?: unknown; state?: unknown };
  if (typeof id !== "string" || typeof state !== "string" || !ORACLE_TERMINAL_STATES.has(state)) return false;
  if (!pi.events) return false;
  pi.events.emit(ORACLE_FINISHED_CHANNEL, { id, state });
  return true;
}

function registerTool(pi: Pi, name: string, description: string, parameters: unknown, map: (args: Record<string, unknown>) => [string, Record<string, unknown>, number | undefined]) {
  pi.registerTool({
    name,
    label: name,
    description,
    parameters,
    async execute(_id: string, args: Record<string, unknown>) {
      try {
        const [tool, toolArgs, tabId] = map(args);
        return await requestSurf(tool, toolArgs, tabId);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  });
}

export default function surfExtension(pi: Pi) {
  registerTool(pi, "surf_read", "Read the current Surf browser page. Read tools are safer for parallel scouts than browser actions.", Type.Object({
    tabId: Type.Optional(Type.Number()), filter: Type.Optional(Type.String()), depth: Type.Optional(Type.Number()), ref: Type.Optional(Type.String()), compact: Type.Optional(Type.Boolean()), maxBytes: Type.Optional(Type.Number()),
  }), (args) => ["page.read", { filter: args.filter, depth: args.depth, ref: args.ref, compact: args.compact, "max-bytes": args.maxBytes }, args.tabId as number | undefined]);
  registerTool(pi, "surf_screenshot", "Capture a bounded Surf browser screenshot.", Type.Object({
    tabId: Type.Optional(Type.Number()), output: Type.Optional(Type.String()), fullpage: Type.Optional(Type.Boolean()), annotate: Type.Optional(Type.Boolean()), maxSize: Type.Optional(Type.Number()),
  }), (args) => ["screenshot", { output: args.output, fullpage: args.fullpage, annotate: args.annotate, "max-size": args.maxSize }, args.tabId as number | undefined]);
  registerTool(pi, "surf_click", "Click a Surf browser element by ref, selector, or coordinates. This can interfere with other agents in the shared browser session.", Type.Object({
    tabId: Type.Optional(Type.Number()), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), button: Type.Optional(Type.String({ description: "left, right, or double" })),
  }), (args) => [args.button === "right" ? "right_click" : args.button === "double" ? "double_click" : "click", args, args.tabId as number | undefined]);
  registerTool(pi, "surf_type", "Type text in the Surf browser. This can interfere with other agents in the shared browser session.", Type.Object({
    tabId: Type.Optional(Type.Number()), text: Type.String(), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), clear: Type.Optional(Type.Boolean()), submit: Type.Optional(Type.Boolean()),
  }), (args) => ["type", args, args.tabId as number | undefined]);
  registerTool(pi, "surf_tool", "Run one existing Surf browser tool through the native host. Prefer the dedicated read, screenshot, click, and type tools when they fit.", Type.Object({
    tool: Type.String(), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())), tabId: Type.Optional(Type.Number()),
  }), (args) => [args.tool as string, (args.args as Record<string, unknown>) ?? {}, args.tabId as number | undefined]);
  registerTool(pi, "surf_oracle_status", "Get the status of a Surf oracle job, or the newest job.", Type.Object({ id: Type.Optional(Type.String()) }), (args) => ["oracle.status", args, undefined]);
  pi.registerTool({
    name: "surf_oracle_result",
    label: "surf_oracle_result",
    description: "Capture the result of a Surf oracle job.",
    parameters: Type.Object({ id: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute(_id: string, args: Record<string, unknown>) {
      try {
        const result = await requestSurf("oracle.result", args);
        emitOracleFinished(pi, result.details ?? { id: args.id, state: result.isError ? "failed" : undefined });
        return result;
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  const oracleJobIds = new Set<string>();
  let sessionGeneration = 0;
  let sessionActive = false;
  pi.registerTool({
    name: "surf_oracle_ask",
    label: "surf_oracle_ask",
    description: "Start a durable local Surf ChatGPT oracle job.",
    parameters: Type.Object({ prompt: Type.String(), model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()), follow: Type.Optional(Type.String()) }),
    async execute(_id: string, args: Record<string, unknown>) {
      const requestGeneration = sessionGeneration;
      try {
        const result = await requestSurf("oracle.ask", args);
        const job = result.details as { id?: string } | undefined;
        rememberOracleJobForSession(oracleJobIds, job?.id, requestGeneration, sessionGeneration, sessionActive);
        return result;
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  let dispose: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    sessionGeneration++;
    const generation = sessionGeneration;
    sessionActive = false;
    dispose?.();
    dispose = undefined;
    oracleJobIds.clear();

    const session = ctx as { sessionManager?: { getSessionId?: () => string }; sessionId?: string };
    const sessionId = session.sessionId ?? session.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    try {
      const jobs = require("../native/oracle-jobs.cjs") as { listJobs(): Array<{ id: string; state: string }> };
      dispose = registerOptionalBackgroundProvider(sessionId, oracleJobIds, jobs.listJobs, registerGlobalBackgroundProvider);
      sessionActive = true;
      void resolveBackgroundWorkRegister().then((register) => {
        try {
          if (register === registerGlobalBackgroundProvider || generation !== sessionGeneration) return;
          const nextDispose = registerOptionalBackgroundProvider(sessionId, oracleJobIds, jobs.listJobs, register);
          if (generation !== sessionGeneration) {
            nextDispose();
            return;
          }
          dispose?.();
          dispose = nextDispose;
        } catch {
          // Keep the already-registered fallback provider.
        }
      });
    } catch {
      // The Pi bridge is optional. Browser tools work without pi-subagents.
    }
  });
  pi.on("session_shutdown", () => {
    sessionGeneration++;
    sessionActive = false;
    dispose?.();
    dispose = undefined;
    oracleJobIds.clear();
  });
}
