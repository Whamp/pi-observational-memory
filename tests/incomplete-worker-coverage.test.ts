import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { runConsolidationPipeline } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
  foldLedger,
  latestCoverageMarkerId,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  type Entry,
} from "../src/session-ledger/index.js";
import type { WorkerStreamSimple } from "../src/agents/worker-stream.js";
import { observation, observationsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

const MODEL = {
  id: "completion-repro",
  name: "Completion repro",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<"anthropic-messages">;

function providerStream(content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    timestamp: 1,
    stopReason,
    content,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  stream.push({ type: "done", reason: stopReason, message });
  return stream;
}

function observationCall(id: string, arguments_: JsonObject): AssistantMessage["content"][number] {
  return { type: "toolCall", id, name: "record_observations", arguments: arguments_ };
}

function observationScenario(validSupport = true) {
  let entries: Entry[] = [
    textCustomMessage("raw-1", "User prefers deterministic tests."),
    textCustomMessage("raw-2", "User also requires useful failure messages."),
  ];
  let requests = 0;
  let runtime = createRuntime();

  const streamSimple: WorkerStreamSimple = () => {
    requests++;
    return providerStream(
      [
        observationCall(`call-${requests}`, {
          complete: false,
          observations: [
            {
              timestamp: "2026-05-02 10:30",
              content: "User prefers deterministic tests.",
              relevance: "high",
              sourceEntryIds: [validSupport ? "raw-1" : "invented"],
            },
          ],
        }),
      ],
      "toolUse",
    );
  };
  const modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test-only" }),
    streamSimple,
  };
  const pi = createLedgerWriter(
    () => entries,
    (nextEntries) => {
      entries = nextEntries;
    },
  );
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    model: MODEL,
    modelRegistry,
    sessionManager: { getBranch: () => entries },
  };

  return {
    get entries() {
      return entries;
    },
    get runtime() {
      return runtime;
    },
    requests: () => requests,
    run: () => runConsolidationPipeline(pi, runtime, context),
    restart() {
      entries = structuredClone(entries);
      const config = runtime.config;
      runtime = createRuntime();
      runtime.config = config;
    },
  };
}

function reflectionScenario() {
  const observations = [
    observation("aaaaaaaaaaaa", {
      content: "User needs reliable memory for requirement one.",
      sourceEntryIds: ["raw-1"],
      tokenCount: 100,
    }),
    observation("bbbbbbbbbbbb", {
      content: "User needs reliable memory for requirement two.",
      sourceEntryIds: ["raw-1"],
      tokenCount: 100,
    }),
  ];
  const entries: Entry[] = [
    textCustomMessage("raw-1", "User needs useful and reliable memory."),
    observationsRecordedEntry("observed", { observations, coversUpToId: "raw-1" }),
  ];
  const runtime = createRuntime({
    observeAfterTokens: 1_000_000,
    reflectAfterTokens: 1,
    observationsPoolTargetTokens: 1,
  });
  const requests: string[] = [];
  const streamSimple: WorkerStreamSimple = (_model, context) => {
    const isReflector = getCurrentTools(context.messages).some(
      (tool) => tool.name === "record_reflections",
    );
    requests.push(isReflector ? "reflector" : "dropper");
    const content: AssistantMessage["content"] = isReflector
      ? [
          {
            type: "toolCall",
            name: "record_reflections",
            id: "partial-reflection",
            arguments: {
              complete: false,
              reflections: [
                {
                  content: "Reliable memory is required.",
                  supportingObservationIds: ["aaaaaaaaaaaa"],
                },
              ],
            },
          },
        ]
      : [{ type: "text", text: "Nothing to drop." }];
    return providerStream(content, isReflector ? "toolUse" : "stop");
  };
  const modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test-only" }),
    streamSimple,
  };
  const pi = createLedgerWriter(
    () => entries,
    (nextEntries) => {
      entries.splice(0, entries.length, ...nextEntries);
    },
  );
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    model: MODEL,
    modelRegistry,
    sessionManager: { getBranch: () => entries },
  };

  return { entries, requests, run: () => runConsolidationPipeline(pi, runtime, context) };
}

function createRuntime(overrides: Partial<typeof DEFAULTS> = {}): Runtime {
  const runtime = new Runtime();
  runtime.configLoaded = true;
  runtime.config = {
    ...DEFAULTS,
    observeAfterTokens: 1,
    reflectAfterTokens: 1_000_000,
    agentMaxTurns: 1,
    ...overrides,
  };
  return runtime;
}

function createLedgerWriter(
  getEntries: () => Entry[],
  setEntries: (entries: Entry[]) => void,
): ExtensionAPI {
  const ledgerWriter: Pick<ExtensionAPI, "appendEntry"> = {
    appendEntry(customType, data) {
      setEntries([
        ...getEntries(),
        { type: "custom", id: `saved-${getEntries().length}`, customType, data },
      ]);
    },
  };
  // SAFETY: the pipeline writes through appendEntry only, and this adapter implements that method with the same arguments and effect.
  return ledgerWriter as ExtensionAPI;
}

describe("incomplete worker coverage through the real consolidation pipeline", () => {
  it("keeps accepted partial observations without covering the submitted source span", async () => {
    const run = observationScenario();
    await run.run();

    expect(run.requests()).toBe(1);
    expect(foldLedger(run.entries).activeObservations.map((record) => record.content)).toEqual([
      "User prefers deterministic tests.",
    ]);
    expect(latestCoverageMarkerId(run.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
  });

  it("retries unfinished source input without duplicating accepted observations", async () => {
    const run = observationScenario();
    await run.run();
    await run.run();

    expect(run.requests()).toBe(2);
    expect(foldLedger(run.entries).activeObservations.map((record) => record.content)).toEqual([
      "User prefers deterministic tests.",
    ]);
  });

  it("retries unfinished source input after restoring entries into a fresh Runtime", async () => {
    const run = observationScenario();
    await run.run();
    run.restart();
    await run.run();

    expect(run.requests()).toBe(2);
    expect(foldLedger(run.entries).activeObservations.map((record) => record.content)).toEqual([
      "User prefers deterministic tests.",
    ]);
  });

  it("keeps partial reflections without completing observation review", async () => {
    const run = reflectionScenario();
    await run.run();

    expect(foldLedger(run.entries).reflections.map((record) => record.content)).toEqual([
      "Reliable memory is required.",
    ]);
    expect(latestCoverageMarkerId(run.entries, OM_REFLECTIONS_RECORDED)).toBeUndefined();
  });

  it("does not launch the dropper after an incomplete reflection review", async () => {
    const run = reflectionScenario();
    await run.run();

    expect(run.requests).toEqual(["reflector"]);
  });

  it("leaves rejected incomplete work uncovered and retryable", async () => {
    const run = observationScenario(false);
    await run.run();
    await run.run();

    expect(run.requests()).toBe(2);
    expect(foldLedger(run.entries).activeObservations).toEqual([]);
    expect(latestCoverageMarkerId(run.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
  });
});
