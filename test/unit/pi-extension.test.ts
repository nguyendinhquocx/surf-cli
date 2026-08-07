import { describe, expect, it } from "vitest";

const {
  createToolRequest,
  registerGlobalBackgroundProvider,
  registerOptionalBackgroundProvider,
  rememberOracleJobForSession,
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
    let provider: { listActiveWork(): Array<{ id: string; sessionId: string }> } | undefined;
    const jobIds = new Set(["mine"]);
    const dispose = registerOptionalBackgroundProvider(
      "pi-session",
      jobIds,
      () => [
        { id: "mine", state: "awaiting" },
        { id: "done", state: "captured" },
        { id: "other", state: "dispatched" },
      ],
      (registered: { listActiveWork(): Array<{ id: string; sessionId: string }> }) => {
        provider = registered;
        return () => {
          provider = undefined;
        };
      },
    );

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
});
