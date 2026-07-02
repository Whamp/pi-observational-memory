#!/usr/bin/env node
/**
 * PROTOTYPE — throwaway. Delete or absorb once the hook design is decided.
 *
 * Question:
 *   Can Pi's native auto-compaction path let a session_before_compact hook replace
 *   old raw context with an observational-memory ledger summary, then continue the
 *   agent automatically?
 *
 * One-command run:
 *   npm run prototype:auto-compaction
 *
 * This uses Pi's real SDK/session/extension/compaction loop plus pi-ai's faux
 * provider. It performs no network calls and writes no sessions to disk.
 */

import {
  AuthStorage,
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";

const OLD_RAW_SENTINEL = "RAW_OLD_CONTEXT_SENTINEL_DO_NOT_SURVIVE_COMPACTION";
const CURRENT_PROMPT_SENTINEL = "CURRENT_PROMPT_SENTINEL_RETAINED_FOR_RETRY";
const LEDGER_SENTINEL = "LEDGER_SUMMARY_SENTINEL_FROM_SESSION_BEFORE_COMPACT";

const providerContexts = [];
const extensionEvents = [];
const sessionEvents = [];

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall") return `${block.name}:${JSON.stringify(block.arguments)}`;
      return JSON.stringify(block);
    })
    .join("\n");
}

function messageToText(message) {
  if (message.role === "user" || message.role === "assistant" || message.role === "custom") {
    return contentToText(message.content);
  }
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return message.summary ?? "";
  }
  if (message.role === "toolResult") {
    return `${message.toolName ?? "tool"}\n${contentToText(message.content)}`;
  }
  return JSON.stringify(message);
}

function contextText(context) {
  return context.messages.map((message) => `${message.role}:${messageToText(message)}`).join("\n---\n");
}

function captureProviderContext(label, context) {
  const text = contextText(context);
  const snapshot = {
    label,
    messageRoles: context.messages.map((message) => message.role),
    hasOldRaw: text.includes(OLD_RAW_SENTINEL),
    hasCurrentPrompt: text.includes(CURRENT_PROMPT_SENTINEL),
    hasLedger: text.includes(LEDGER_SENTINEL),
    text,
  };
  providerContexts.push(snapshot);
  return snapshot;
}

function summarizeBranch(sessionManager) {
  const branch = sessionManager.getBranch();
  const sessionContext = buildSessionContext(branch, sessionManager.getLeafId());
  const text = sessionContext.messages.map(messageToText).join("\n---\n");
  return {
    entries: branch.map((entry) => ({
      type: entry.type,
      role: entry.type === "message" ? entry.message.role : undefined,
      fromHook: entry.type === "compaction" ? entry.fromHook === true : undefined,
      firstKeptEntryId: entry.type === "compaction" ? entry.firstKeptEntryId : undefined,
    })),
    contextRoles: sessionContext.messages.map((message) => message.role),
    contextHasOldRaw: text.includes(OLD_RAW_SENTINEL),
    contextHasCurrentPrompt: text.includes(CURRENT_PROMPT_SENTINEL),
    contextHasLedger: text.includes(LEDGER_SENTINEL),
  };
}

function printState(label, sessionManager) {
  const state = summarizeBranch(sessionManager);
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(state, null, 2));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting ${timeoutMs}ms for prototype condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function main() {
  console.log("PROTOTYPE — auto-compaction + ledger replacement + continuation");
  console.log("Question: can session_before_compact replace old raw context with a ledger, then native overflow recovery continue?");

  const faux = registerFauxProvider({
    api: "prototype-faux-api",
    provider: "prototype-faux",
    tokenSize: { min: 128, max: 128 },
    models: [
      {
        id: "prototype-model",
        name: "Prototype Faux Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 80,
      },
    ],
  });

  const authStorage = AuthStorage.inMemory({
    "prototype-faux": { type: "api_key", key: "prototype" },
  });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    // Keep threshold compaction out of the way; this prototype is about overflow
    // recovery. reserveTokens=1 means threshold compaction only fires near the
    // faux model's 1000-token window, while this tiny scenario stays below it.
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
    // Keep provider errors from taking the generic retry path before compaction sees them.
    retry: { enabled: false },
  });
  const sessionManager = SessionManager.inMemory(process.cwd());

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: "/tmp/pi-observational-memory-auto-compaction-prototype-agent-dir",
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Prototype harness. Keep responses minimal.",
    extensionFactories: [
      (pi) => {
        pi.on("session_before_compact", async (event) => {
          extensionEvents.push({
            type: event.type,
            reason: event.reason,
            willRetry: event.willRetry,
            messagesToSummarize: event.preparation.messagesToSummarize.length,
            turnPrefixMessages: event.preparation.turnPrefixMessages.length,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
          });

          return {
            compaction: {
              summary: [
                "## Observational Memory Ledger Prototype",
                LEDGER_SENTINEL,
                "- Old raw conversation was intentionally replaced by this ledger summary.",
                "- The current prompt tail is retained by Pi's firstKeptEntryId.",
              ].join("\n"),
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: {
                prototype: "auto-compaction-ledger-replacement",
                ledgerSentinel: LEDGER_SENTINEL,
                oldRawRedacted: true,
              },
            },
          };
        });

        pi.on("session_compact", async (event) => {
          extensionEvents.push({
            type: event.type,
            reason: event.reason,
            willRetry: event.willRetry,
            fromExtension: event.fromExtension,
            summaryHasLedger: event.compactionEntry.summary.includes(LEDGER_SENTINEL),
          });
        });
      },
    ],
  });
  await resourceLoader.reload();

  faux.setResponses([
    (context) => {
      captureProviderContext("warmup", context);
      return fauxAssistantMessage("warmup complete");
    },
    (context) => {
      captureProviderContext("overflow-error", context);
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 1200 tokens > 1000 maximum",
      });
    },
    (context) => {
      const seen = captureProviderContext("retry-after-compaction", context);
      return fauxAssistantMessage(
        `retry context: oldRaw=${seen.hasOldRaw}; ledger=${seen.hasLedger}; current=${seen.hasCurrentPrompt}`,
      );
    },
  ]);

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: "/tmp/pi-observational-memory-auto-compaction-prototype-agent-dir",
    authStorage,
    modelRegistry,
    model: faux.getModel(),
    thinkingLevel: "off",
    resourceLoader,
    tools: [],
    sessionManager,
    settingsManager,
  });

  session.subscribe((event) => {
    if (
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "message_end"
    ) {
      sessionEvents.push({
        type: event.type,
        role: event.type === "message_end" ? event.message.role : undefined,
        stopReason: event.type === "message_end" && event.message.role === "assistant" ? event.message.stopReason : undefined,
        reason: "reason" in event ? event.reason : undefined,
        willRetry: "willRetry" in event ? event.willRetry : undefined,
        aborted: "aborted" in event ? event.aborted : undefined,
      });
    }
  });

  try {
    await session.prompt(
      [
        "Warm up the session with old raw context.",
        OLD_RAW_SENTINEL,
        "This first turn should be removed from the retry context after compaction.",
      ].join("\n"),
      { expandPromptTemplates: false },
    );
    printState("after warmup: raw context exists, no compaction yet", sessionManager);

    await session.prompt(
      [
        "Trigger a context-overflow retry now.",
        CURRENT_PROMPT_SENTINEL,
        "The retry should keep this current prompt but replace older raw context with the ledger.",
      ].join("\n"),
      { expandPromptTemplates: false },
    );

    const providerCallsWhenPromptResolved = providerContexts.length;
    await waitFor(() => providerContexts.length >= 3, 2_000);
    const continuationTiming =
      providerCallsWhenPromptResolved >= 3 ? "before session.prompt resolved" : "after session.prompt resolved via scheduled/native continuation";

    printState("after overflow recovery: ledger summary replaces old raw context", sessionManager);
    console.log(`\nContinuation timing: ${continuationTiming}`);

    console.log("\n=== provider call contexts ===");
    console.log(JSON.stringify(providerContexts.map(({ text, ...rest }) => rest), null, 2));

    console.log("\n=== extension events ===");
    console.log(JSON.stringify(extensionEvents, null, 2));

    console.log("\n=== session events ===");
    console.log(JSON.stringify(sessionEvents, null, 2));

    const retryContext = providerContexts.find((context) => context.label === "retry-after-compaction");
    const branchState = summarizeBranch(sessionManager);
    const compactionEntry = sessionManager.getBranch().find((entry) => entry.type === "compaction");

    assert(providerContexts.length === 3, `expected exactly 3 provider calls, got ${providerContexts.length}`);
    assert(retryContext, "missing retry-after-compaction provider context");
    assert(retryContext.hasLedger, "retry context did not contain the ledger summary");
    assert(!retryContext.hasOldRaw, "retry context still contained old raw context");
    assert(retryContext.hasCurrentPrompt, "retry context lost the current prompt that should be retried");
    assert(compactionEntry, "session did not append a compaction entry");
    assert(compactionEntry.fromHook === true, "compaction entry was not marked as extension-provided");
    assert(branchState.contextHasLedger, "rebuilt session context does not contain the ledger");
    assert(!branchState.contextHasOldRaw, "rebuilt session context still contains old raw context");
    assert(
      sessionEvents.some((event) => event.type === "compaction_start" && event.reason === "overflow"),
      "native overflow compaction did not start",
    );
    assert(
      sessionEvents.some((event) => event.type === "compaction_end" && event.reason === "overflow" && event.willRetry === true),
      "native overflow compaction did not finish with willRetry=true",
    );
    assert(extensionEvents.some((event) => event.type === "session_before_compact"), "session_before_compact did not run");
    assert(extensionEvents.some((event) => event.type === "session_compact" && event.fromExtension === true && event.summaryHasLedger === true), "session_compact did not report extension-provided ledger compaction");

    console.log("\nPASS: Pi native overflow auto-compaction used session_before_compact, replaced old raw context with the ledger, rebuilt context, and continued automatically.");
  } finally {
    session.dispose();
    faux.unregister();
  }
}

main().catch((error) => {
  console.error("\nFAIL:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
