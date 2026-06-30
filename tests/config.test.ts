import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { DEFAULTS, loadConfig, readEnvConfig, resolveStageModel, resolveStageModelConfig, resolveStageThinking, type Config, type StageModelConfig } from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("V3 config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses V3 defaults", () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			reflectAfterTokens: 20000,
			compactAfterTokens: 81000,
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			agentMaxTurns: 16,
			passive: false,
			debugLog: false,
		});
		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("merges global, project, and env V3 settings in order", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 10,
				reflectAfterTokens: 20,
				compactAfterTokens: 30,
				observationsPoolMaxTokens: 40,
				observationsPoolTargetTokens: 15,
				agentMaxTurns: 5,
				model: { provider: "anthropic", id: "global", thinking: "medium" },
				passive: false,
				debugLog: true,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 100,
				model: { provider: "openai", id: "project", thinking: "low" },
			},
		});

		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({
			observeAfterTokens: 100,
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 15,
			agentMaxTurns: 5,
			model: { provider: "openai", id: "project", thinking: "low" },
			passive: true,
			debugLog: true,
		});
	});

	it("ignores invalid V3 values", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: -1,
				reflectAfterTokens: 0,
				compactAfterTokens: 1.5,
				observationsPoolMaxTokens: "20000",
				observationsPoolTargetTokens: "10000",
				agentMaxTurns: null,
				model: { provider: "anthropic", id: "", thinking: "huge" },
				passive: "yes",
				debugLog: "true",
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("derives observation pool target from the final max when omitted", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 80,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("ignores old V2 settings without warnings or aliases", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationThresholdTokens: 10,
				compactionThresholdTokens: 20,
				reflectionThresholdTokens: 30,
				compactionModel: { provider: "anthropic", id: "old" },
				thinkingLevel: "high",
				observerMaxTurnsPerRun: 2,
				reflectorMaxTurnsPerPass: 3,
				prunerMaxTurnsPerPass: 4,
				compactionMaxToolCalls: 5,
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("parses passive env override", () => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "on" })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "0" })).toEqual({ passive: false });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "maybe" })).toEqual({});
	});
});

function baseConfig(overrides: Partial<Config> = {}): Config {
	return { ...DEFAULTS, ...overrides };
}

function sharedModel(thinking?: ModelThinkingLevel): NonNullable<Config["model"]> {
	return thinking ? { provider: "openai", id: "shared", thinking } : { provider: "openai", id: "shared" };
}

describe("stage model resolution", () => {
	it("falls back to the shared model and shared thinking when no stage config is set", () => {
		const config = baseConfig({ model: sharedModel("medium") });
		for (const stage of ["observer", "reflector", "dropper"] as const) {
			expect(resolveStageModel(config, stage)).toEqual({ model: sharedModel("medium"), thinking: "medium" });
		}
	});

	it("defaults thinking to low when the shared model has no thinking", () => {
		const config = baseConfig({ model: sharedModel() });
		for (const stage of ["observer", "reflector", "dropper"] as const) {
			expect(resolveStageThinking(config, stage)).toBe("low");
		}
		expect(resolveStageModelConfig(config, "observer")).toEqual(sharedModel());
	});

	it("uses the session model (undefined) when neither stage nor shared model is set", () => {
		const config = baseConfig();
		for (const stage of ["observer", "reflector", "dropper"] as const) {
			expect(resolveStageModelConfig(config, stage)).toBeUndefined();
			expect(resolveStageThinking(config, stage)).toBe("low");
		}
	});

	it("lets observer override thinking while inheriting the shared model", () => {
		const config = baseConfig({
			model: sharedModel("medium"),
			observer: { thinking: "off" },
		});
		expect(resolveStageModel(config, "observer")).toEqual({ model: sharedModel("medium"), thinking: "off" });
		expect(resolveStageModel(config, "reflector")).toEqual({ model: sharedModel("medium"), thinking: "medium" });
	});

	it("lets a stage override its model", () => {
		const reflectorModel = { provider: "openrouter", id: "refl", thinking: "high" };
		const config = baseConfig({
			model: sharedModel("medium"),
			reflector: { model: reflectorModel },
		});
		expect(resolveStageModelConfig(config, "reflector")).toEqual(reflectorModel);
		expect(resolveStageModelConfig(config, "observer")).toEqual(sharedModel("medium"));
		expect(resolveStageModelConfig(config, "dropper")).toEqual(reflectorModel);
	});

	it("prefers explicit stage thinking over the stage model thinking", () => {
		const config = baseConfig({
			model: sharedModel("medium"),
			reflector: { model: { provider: "openrouter", id: "refl", thinking: "high" }, thinking: "low" },
		});
		expect(resolveStageThinking(config, "reflector")).toBe("low");
	});

	it("falls back to stage model thinking when explicit stage thinking is unset", () => {
		const config = baseConfig({
			model: sharedModel("medium"),
			observer: { model: { provider: "openrouter", id: "om", thinking: "xhigh" } },
		});
		expect(resolveStageThinking(config, "observer")).toBe("xhigh");
	});

	it("dropper inherits reflector model and reflector thinking when dropper config is unset", () => {
		const reflectorModel = { provider: "openrouter", id: "refl", thinking: "high" };
		const config = baseConfig({
			model: sharedModel("medium"),
			reflector: { model: reflectorModel, thinking: "low" },
		});
		expect(resolveStageModelConfig(config, "dropper")).toEqual(reflectorModel);
		expect(resolveStageThinking(config, "dropper")).toBe("low");
	});

	it("dropper own override beats inherited reflector values", () => {
		const config = baseConfig({
			model: sharedModel("medium"),
			reflector: { thinking: "high" },
			dropper: { thinking: "off", model: { provider: "openrouter", id: "drop" } },
		});
		expect(resolveStageModelConfig(config, "dropper")).toEqual({ provider: "openrouter", id: "drop" });
		expect(resolveStageThinking(config, "dropper")).toBe("off");
	});

	it("dropper model inherits reflector, then shared, then session", () => {
		const reflectorModel = { provider: "openrouter", id: "refl" };
		expect(resolveStageModelConfig(baseConfig({ model: sharedModel("medium"), reflector: { model: reflectorModel } }), "dropper")).toEqual(reflectorModel);
		expect(resolveStageModelConfig(baseConfig({ model: sharedModel("medium") }), "dropper")).toEqual(sharedModel("medium"));
		expect(resolveStageModelConfig(baseConfig(), "dropper")).toBeUndefined();
	});
});

describe("stage config normalization", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-stage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("parses valid stage overrides from project settings", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				model: { provider: "openai", id: "shared", thinking: "medium" },
				observer: { thinking: "off" },
				reflector: { model: { provider: "openrouter", id: "refl", thinking: "high" } },
				dropper: { thinking: "medium" },
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			model: { provider: "openai", id: "shared", thinking: "medium" },
			observer: { thinking: "off" },
			reflector: { model: { provider: "openrouter", id: "refl", thinking: "high" } },
			dropper: { thinking: "medium" },
		});
	});

	it("ignores invalid stage config shapes", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observer: "nope",
				reflector: { model: { provider: "openrouter", id: "" }, thinking: "huge" },
				dropper: {},
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("project stage config overrides global stage config", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observer: { thinking: "off" },
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observer: { thinking: "low" },
			},
		});

		const config = loadConfig(cwd, {});
		expect(resolveStageThinking(config, "observer")).toBe("low");
	});
});
