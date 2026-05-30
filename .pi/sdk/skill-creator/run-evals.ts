#!/usr/bin/env -S node --experimental-strip-types

const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FALLBACK_PI_MODULE =
	"/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const FALLBACK_PI_AI_MODULE =
	"/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";

async function importWithFallback(specifier, fallbackPath) {
	try {
		return await import(specifier);
	} catch (_error) {
		return await import(pathToFileURL(fallbackPath).href);
	}
}

async function loadPiModules() {
	const pi = await importWithFallback("@earendil-works/pi-coding-agent", FALLBACK_PI_MODULE);
	const piAi = await importWithFallback("@earendil-works/pi-ai", FALLBACK_PI_AI_MODULE);
	return { pi, piAi };
}

function printUsage() {
	console.log(`Usage:
  run-evals.ts --skill-path <dir> --workspace <dir> --iteration <n> [options]

Options:
  --skill-path <dir>       Target skill directory (required)
  --workspace <dir>        Workspace directory (required)
  --eval-set <file>        Evals file (default: <skill-path>/evals/evals.json)
  --iteration <n>          Iteration number (required)
  --baseline-mode <mode>   none | without-skill | snapshot (default: without-skill)
  --snapshot-path <dir>    Snapshot skill directory for snapshot baseline
  --cwd <dir>              Working directory for agent runs (default: inferred project root)
  --model <pattern>        Optional model id or provider/model reference
  --thinking <level>       off | minimal | low | medium | high | xhigh
  --runs-per-eval <n>      Number of runs per configuration (default: 1)
  --help                   Show this help
`);
}

function parseArgs(argv) {
	const options = {
		baselineMode: "without-skill",
		runsPerEval: 1,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected argument: ${arg}`);
		}

		const key = arg.slice(2);
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`Missing value for --${key}`);
		}
		options[key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
		i += 1;
	}

	if (options.iteration !== undefined) {
		options.iteration = Number.parseInt(String(options.iteration), 10);
	}
	if (options.runsPerEval !== undefined) {
		options.runsPerEval = Number.parseInt(String(options.runsPerEval), 10);
	}

	return options;
}

function sanitizeNamePart(value) {
	return String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "item";
}

function inferProjectRootFromSkillPath(skillPath) {
	const parent = path.dirname(skillPath);
	const grandparent = path.dirname(parent);
	if (path.basename(parent) === "skills" && path.basename(grandparent) === ".pi") {
		return path.dirname(grandparent);
	}
	return path.dirname(skillPath);
}

async function ensureDir(dirPath) {
	await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
	const raw = await fs.readFile(filePath, "utf8");
	return JSON.parse(raw);
}

async function writeJson(filePath, value) {
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, text) {
	await fs.writeFile(filePath, text, "utf8");
}

function resolveMaybeRelative(baseDir, maybeRelativePath) {
	if (path.isAbsolute(maybeRelativePath)) {
		return maybeRelativePath;
	}
	return path.resolve(baseDir, maybeRelativePath);
}

async function discoverSingleSkill(pi, skillDir) {
	const result = pi.loadSkillsFromDir({ dir: skillDir, source: "sdk-run-evals" });
	if (!result.skills || result.skills.length === 0) {
		throw new Error(`No skill discovered in ${skillDir}`);
	}
	if (result.skills.length > 1) {
		throw new Error(`Expected one skill in ${skillDir}, found ${result.skills.length}`);
	}
	return { skill: result.skills[0], diagnostics: result.diagnostics ?? [] };
}

function findLastAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((item) => item?.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function formatMessageContent(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "text") {
			parts.push(item.text);
		} else if (item.type === "image") {
			parts.push("[image]");
		} else if (item.type === "thinking") {
			parts.push("[thinking]");
		} else {
			parts.push(`[${item.type ?? "content"}]`);
		}
	}
	return parts.join("\n").trim();
}

function formatMessagesAsTranscript(messages) {
	const lines = ["# Transcript", ""];
	for (const message of messages) {
		const role = message?.role ?? "unknown";
		lines.push(`## ${role}`);
		const body = formatMessageContent(message?.content);
		lines.push(body || "[no text content]");
		lines.push("");
	}
	return lines.join("\n");
}

function buildPromptForEval(evalCase, options) {
	const lines = [evalCase.prompt.trim()];

	if (options.configuration === "with-skill") {
		lines.push(
			"",
			"The target skill is available for this run. If it is relevant, read and use it.",
		);
	}

	if (options.configuration === "snapshot") {
		lines.push(
			"",
			"A snapshot version of the target skill is available for this run. If it is relevant, read and use it.",
		);
	}

	if (options.inputFiles.length > 0) {
		lines.push("", "Input files to read as needed:");
		for (const filePath of options.inputFiles) {
			lines.push(`- ${filePath}`);
		}
	}

	lines.push(
		"",
		"If you create files as part of this eval, save them under this directory:",
		options.outputDir,
	);

	if (evalCase.expected_output) {
		lines.push("", "Expected outcome:", String(evalCase.expected_output));
	}

	return lines.join("\n");
}

function createEventRecorder() {
	const eventLines = [];
	const metrics = {
		toolExecutionStarts: 0,
		toolExecutionEnds: 0,
		toolErrors: 0,
		assistantTextChars: 0,
		thinkingChars: 0,
	};

	return {
		record(event) {
			switch (event.type) {
				case "agent_start":
					eventLines.push("- agent_start");
					break;
				case "agent_end":
					eventLines.push("- agent_end");
					break;
				case "turn_start":
					eventLines.push("- turn_start");
					break;
				case "turn_end":
					eventLines.push(`- turn_end (toolResults=${event.toolResults?.length ?? 0})`);
					break;
				case "tool_execution_start":
					metrics.toolExecutionStarts += 1;
					eventLines.push(`- tool_start: ${event.toolName}`);
					break;
				case "tool_execution_end":
					metrics.toolExecutionEnds += 1;
					if (event.isError) metrics.toolErrors += 1;
					eventLines.push(`- tool_end: ${event.toolName} (${event.isError ? "error" : "ok"})`);
					break;
				case "message_update":
					if (event.assistantMessageEvent?.type === "text_delta") {
						metrics.assistantTextChars += event.assistantMessageEvent.delta.length;
					}
					if (event.assistantMessageEvent?.type === "thinking_delta") {
						metrics.thinkingChars += event.assistantMessageEvent.delta.length;
					}
					break;
			}
		},
		getMetrics() {
			return metrics;
		},
		getLog() {
			return ["# Event Log", "", ...eventLines].join("\n");
		},
	};
}

function chooseModel(modelRegistry, modelPattern) {
	if (!modelPattern) return { model: undefined, warning: undefined };

	const available = typeof modelRegistry.getAvailable === "function" ? modelRegistry.getAvailable() : [];
	if (!Array.isArray(available) || available.length === 0) {
		return { model: undefined, warning: `No available models found while resolving --model ${modelPattern}` };
	}

	const direct = available.find(
		(model) => `${model.provider}/${model.id}` === modelPattern || model.id === modelPattern || model.name === modelPattern,
	);
	if (direct) return { model: direct, warning: undefined };

	const partial = available.filter(
		(model) =>
			`${model.provider}/${model.id}`.includes(modelPattern) ||
			model.id.includes(modelPattern) ||
			(model.name && model.name.includes(modelPattern)),
	);
	if (partial.length === 1) {
		return { model: partial[0], warning: undefined };
	}
	if (partial.length > 1) {
		return {
			model: undefined,
			warning: `Model pattern ${modelPattern} matched multiple models: ${partial
				.map((model) => `${model.provider}/${model.id}`)
				.join(", ")}`,
		};
	}

	return { model: undefined, warning: `Model pattern did not match any available model: ${modelPattern}` };
}

async function createResourceLoader(pi, options) {
	const loader = new pi.DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		skillsOverride: () => ({
			skills: options.skill ? [options.skill] : [],
			diagnostics: [],
		}),
	});
	await loader.reload();
	return loader;
}

async function runSingleSession(pi, sessionOptions) {
	const sessionManager = pi.SessionManager.inMemory(sessionOptions.cwd);
	const { session } = await pi.createAgentSession({
		cwd: sessionOptions.cwd,
		model: sessionOptions.model,
		thinkingLevel: sessionOptions.thinking,
		resourceLoader: sessionOptions.resourceLoader,
		sessionManager,
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	});

	const recorder = createEventRecorder();
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	const unsubscribe = session.subscribe((event) => recorder.record(event));

	let success = true;
	let errorMessage;

	try {
		await session.prompt(sessionOptions.prompt);
	} catch (error) {
		success = false;
		errorMessage = error instanceof Error ? error.message : String(error);
	}

	const endedAt = new Date().toISOString();
	const durationMs = Date.now() - startedMs;
	const messages = session.agent?.state?.messages ?? [];
	const finalAssistantText = findLastAssistantText(messages);
	const transcript = formatMessagesAsTranscript(messages);
	unsubscribe();
	await session.dispose();

	return {
		success,
		errorMessage,
		startedAt,
		endedAt,
		durationMs,
		messages,
		finalAssistantText,
		transcript,
		eventLog: recorder.getLog(),
		metrics: recorder.getMetrics(),
	};
}

async function writeRunArtifacts(runDir, runResult, metadata) {
	await ensureDir(runDir);
	await ensureDir(path.join(runDir, "outputs"));

	const assistantOutputPath = path.join(runDir, "outputs", "assistant-final.md");
	await writeText(assistantOutputPath, `${runResult.finalAssistantText || ""}\n`);
	await writeText(path.join(runDir, "transcript.md"), `${runResult.transcript}\n\n${runResult.eventLog}\n`);
	await writeJson(path.join(runDir, "messages.json"), runResult.messages);
	await writeJson(path.join(runDir, "timing.json"), {
		startedAt: runResult.startedAt,
		endedAt: runResult.endedAt,
		durationMs: runResult.durationMs,
		totalDurationSeconds: Number((runResult.durationMs / 1000).toFixed(3)),
	});
	await writeJson(path.join(runDir, "metrics.json"), {
		...runResult.metrics,
		messageCount: Array.isArray(runResult.messages) ? runResult.messages.length : 0,
		finalAssistantChars: runResult.finalAssistantText.length,
		outputFiles: [assistantOutputPath],
	});
	await writeJson(path.join(runDir, "run.json"), {
		...metadata,
		success: runResult.success,
		errorMessage: runResult.errorMessage,
		finalAssistantChars: runResult.finalAssistantText.length,
	});
}

function buildConfigurations(options) {
	const configs = [{ name: "with-skill", skillDir: options.skillPath }];
	if (options.baselineMode === "without-skill") {
		configs.push({ name: "without-skill", skillDir: undefined });
	}
	if (options.baselineMode === "snapshot") {
		if (!options.snapshotPath) {
			throw new Error("--snapshot-path is required when --baseline-mode snapshot is used");
		}
		configs.push({ name: "snapshot", skillDir: options.snapshotPath });
	}
	return configs;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}

	if (!options.skillPath) {
		throw new Error("--skill-path is required");
	}
	if (!options.workspace) {
		throw new Error("--workspace is required");
	}
	if (!Number.isInteger(options.iteration) || options.iteration < 1) {
		throw new Error("--iteration must be a positive integer");
	}
	if (!Number.isInteger(options.runsPerEval) || options.runsPerEval < 1) {
		throw new Error("--runs-per-eval must be a positive integer");
	}
	if (!["none", "without-skill", "snapshot"].includes(options.baselineMode)) {
		throw new Error(`Unsupported --baseline-mode: ${options.baselineMode}`);
	}

	const skillPath = path.resolve(String(options.skillPath));
	const workspacePath = path.resolve(String(options.workspace));
	const evalSetPath = path.resolve(String(options.evalSet ?? path.join(skillPath, "evals", "evals.json")));
	const cwd = path.resolve(String(options.cwd ?? inferProjectRootFromSkillPath(skillPath)));
	const snapshotPath = options.snapshotPath ? path.resolve(String(options.snapshotPath)) : undefined;
	const iterationDir = path.join(workspacePath, `iteration-${options.iteration}`);

	if (!existsSync(skillPath)) {
		throw new Error(`Skill path does not exist: ${skillPath}`);
	}
	if (!existsSync(evalSetPath)) {
		throw new Error(`Eval set does not exist: ${evalSetPath}`);
	}

	await ensureDir(workspacePath);
	await ensureDir(iterationDir);

	const { pi } = await loadPiModules();
	const agentDir = typeof pi.getAgentDir === "function" ? pi.getAgentDir() : undefined;
	const authStorage = pi.AuthStorage.create();
	const modelRegistry = pi.ModelRegistry.create(authStorage);
	const modelChoice = chooseModel(modelRegistry, options.model ? String(options.model) : undefined);
	if (modelChoice.warning) {
		console.warn(`[run-evals] warning: ${modelChoice.warning}`);
	}

	const evalSet = await readJson(evalSetPath);
	if (!Array.isArray(evalSet.evals)) {
		throw new Error(`Invalid eval set: expected 'evals' array in ${evalSetPath}`);
	}

	const withSkill = await discoverSingleSkill(pi, skillPath);
	const snapshotSkill = snapshotPath ? await discoverSingleSkill(pi, snapshotPath) : undefined;

	const configurations = buildConfigurations({
		skillPath,
		snapshotPath,
		baselineMode: options.baselineMode,
	});

	const iterationSummary = {
		skillPath,
		workspacePath,
		cwd,
		evalSetPath,
		iteration: options.iteration,
		baselineMode: options.baselineMode,
		model: modelChoice.model ? `${modelChoice.model.provider}/${modelChoice.model.id}` : null,
		thinking: options.thinking ?? null,
		runsPerEval: options.runsPerEval,
		evals: [],
	};

	for (const evalCase of evalSet.evals) {
		const evalId = sanitizeNamePart(evalCase.id ?? "eval");
		const evalName = sanitizeNamePart(evalCase.name ?? evalCase.prompt?.slice(0, 48) ?? "eval");
		const evalDir = path.join(iterationDir, `eval-${evalId}-${evalName}`);
		await ensureDir(evalDir);

		const inputFiles = Array.isArray(evalCase.files)
			? evalCase.files.map((file) => resolveMaybeRelative(skillPath, file))
			: [];

		await writeJson(path.join(evalDir, "eval_metadata.json"), {
			evalId: evalCase.id,
			evalName: evalCase.name ?? `eval-${evalId}`,
			prompt: evalCase.prompt,
			expectedOutput: evalCase.expected_output ?? null,
			expectations: Array.isArray(evalCase.expectations) ? evalCase.expectations : [],
			files: inputFiles,
			configurations: configurations.map((config) => config.name),
		});

		const evalSummary = {
			evalId: evalCase.id,
			evalName: evalCase.name ?? `eval-${evalId}`,
			configurations: [],
		};

		for (const config of configurations) {
			const configDir = path.join(evalDir, config.name);
			await ensureDir(configDir);

			const skill =
				config.name === "with-skill"
					? withSkill.skill
					: config.name === "snapshot"
						? snapshotSkill?.skill
						: undefined;

			if ((config.name === "snapshot" && !skill) || (config.name === "with-skill" && !skill)) {
				throw new Error(`Missing skill metadata for configuration: ${config.name}`);
			}

			const loader = await createResourceLoader(pi, {
				cwd,
				agentDir,
				skill,
			});

			for (let runNumber = 1; runNumber <= options.runsPerEval; runNumber++) {
				const runDir = options.runsPerEval === 1 ? configDir : path.join(configDir, `run-${runNumber}`);
				await ensureDir(runDir);
				await ensureDir(path.join(runDir, "outputs"));

				const prompt = buildPromptForEval(evalCase, {
					configuration: config.name,
					inputFiles,
					outputDir: path.join(runDir, "outputs"),
				});

				const runResult = await runSingleSession(pi, {
					cwd,
					model: modelChoice.model,
					thinking: options.thinking,
					resourceLoader: loader,
					prompt,
				});

				await writeRunArtifacts(runDir, runResult, {
					configuration: config.name,
					runNumber,
					skillPath: config.skillDir ?? null,
					prompt,
					inputFiles,
					model: modelChoice.model ? `${modelChoice.model.provider}/${modelChoice.model.id}` : null,
					thinking: options.thinking ?? null,
				});

				evalSummary.configurations.push({
					configuration: config.name,
					runNumber,
					runDir,
					success: runResult.success,
					errorMessage: runResult.errorMessage ?? null,
				});
			}
			if (typeof loader.dispose === "function") {
				loader.dispose();
			}
		}

		iterationSummary.evals.push(evalSummary);
	}

	await writeJson(path.join(iterationDir, "iteration.json"), iterationSummary);

	console.log(`Created iteration: ${iterationDir}`);
	console.log(`Eval set: ${evalSetPath}`);
	console.log(`Configurations: ${configurations.map((config) => config.name).join(", ")}`);
	console.log(`Model: ${modelChoice.model ? `${modelChoice.model.provider}/${modelChoice.model.id}` : "default"}`);
	console.log(`Thinking: ${options.thinking ?? "default"}`);
}

main().catch((error) => {
	console.error(`[run-evals] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
