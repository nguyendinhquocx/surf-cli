import { describe, expect, it, vi } from "vitest";

const {
  createToolRequest,
  emitOracleFinished,
  registerGlobalBackgroundProvider,
  registerOptionalBackgroundProvider,
  rememberOracleJobForSession,
  resolveBackgroundWorkRegister,
  resultFromHost,
} = require("../../pi-extension/surf.ts");

const backgroundWorkKey = Symbol.for("pi-subagents.background-work.v1");

describe("Pi extension", () => {
  it("maps browser tools to the native host request frame", () => {
    const request = createToolRequest("page.read", { filter: "interactive" }, 42);

    expect(request).toMatchObject({
      type: "tool_request",
      method: "execute_tool",
      params: { tool: "page.read", args: { filter: "interactive" }, tabId: 42 },
    });
    expect(request.id).toMatch(/^pi-surf-/);
  });

  it("reports only active oracle jobs started by its Pi session", () => {
    let provider:
      | { wakeChannels: string[]; listActiveWork(): Array<{ id: string; sessionId: string }> }
      | undefined;
    const jobIds = new Set(["mine"]);
    const dispose = registerOptionalBackgroundProvider(
      "pi-session",
      jobIds,
      () => [
        { id: "mine", state: "awaiting" },
        { id: "done", state: "captured" },
        { id: "other", state: "dispatched" },
      ],
      (registered: {
        wakeChannels: string[];
        listActiveWork(): Array<{ id: string; sessionId: string }>;
      }) => {
        provider = registered;
        return () => {
          provider = undefined;
        };
      },
    );

    expect(provider?.wakeChannels).toEqual(["surf-oracle:finished"]);
    expect(provider?.listActiveWork()).toEqual([{ id: "mine", sessionId: "pi-session" }]);
    jobIds.clear();
    expect(provider?.listActiveWork()).toEqual([]);
    dispose();
    expect(provider).toBeUndefined();
  });

  it("does not remember oracle jobs that resolve after a session reset", () => {
    const jobIds = new Set<string>();

    expect(rememberOracleJobForSession(jobIds, "old-job", 1, 2, true)).toBe(false);
    expect([...jobIds]).toEqual([]);
    expect(rememberOracleJobForSession(jobIds, "current-job", 2, 2, true)).toBe(true);
    expect([...jobIds]).toEqual(["current-job"]);
    expect(rememberOracleJobForSession(jobIds, "inactive-job", 2, 2, false)).toBe(false);
    expect([...jobIds]).toEqual(["current-job"]);
  });

  it("keeps details parseable when display text is truncated", () => {
    const job = { id: "long-job", state: "captured", response: "x".repeat(21_000) };

    const result = resultFromHost({
      result: { content: [{ type: "text", text: JSON.stringify(job) }] },
    });

    expect(result.details).toEqual(job);
    expect(result.content[0]?.text).toContain("Surf output truncated");
  });

  it("emits the oracle finished wake channel only for terminal jobs", () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const pi = {
      events: {
        emit: (event: string, data: unknown) => emitted.push({ event, data }),
      },
    };

    expect(emitOracleFinished(pi, { id: "running", state: "awaiting" })).toBe(false);
    expect(emitOracleFinished({}, { id: "done", state: "captured" })).toBe(false);
    expect(emitOracleFinished(pi, { id: "done", state: "captured" })).toBe(true);
    expect(emitOracleFinished(pi, { id: "failed", state: "failed" })).toBe(true);

    expect(emitted).toEqual([
      { event: "surf-oracle:finished", data: { id: "done", state: "captured" } },
      { event: "surf-oracle:finished", data: { id: "failed", state: "failed" } },
    ]);
  });

  it("creates the optional pi-subagents background registry lazily", () => {
    delete (globalThis as Record<PropertyKey, unknown>)[backgroundWorkKey];
    const provider = { name: "surf-oracle", wakeChannels: [], listActiveWork: () => [] };

    const dispose = registerGlobalBackgroundProvider(provider);
    const registry = (
      globalThis as unknown as Record<PropertyKey, { providers: Map<string, unknown> }>
    )[backgroundWorkKey];

    expect(registry.providers.get("surf-oracle")).toBe(provider);
    dispose();
    expect(registry.providers.has("surf-oracle")).toBe(false);
    delete (globalThis as Record<PropertyKey, unknown>)[backgroundWorkKey];
  });

  it("prefers the pi-subagents background-work helper when it is available", async () => {
    const register = vi.fn(() => vi.fn());

    await expect(
      resolveBackgroundWorkRegister(async () => ({
        registerBackgroundWorkProvider: register,
      })),
    ).resolves.toBe(register);
  });

  it("keeps the global fallback when pi-subagents is not available", async () => {
    await expect(
      resolveBackgroundWorkRegister(async () => {
        throw new Error("not installed");
      }),
    ).resolves.toBe(registerGlobalBackgroundProvider);
  });
});
