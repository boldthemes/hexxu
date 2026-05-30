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
  optimize-description.ts --skill-path <dir> --workspace <dir> [options]

Trigger-eval-driven optimization of a skill's frontmatter description.
The signal for "triggered" is: the model issued a Read on any file under the
skill directory during the session (see references/sdk-spec.md, Trigger detection).

Options:
  --skill-path <dir>       Target skill directory (required)
  --workspace <dir>        Workspace directory (required)
  --eval-set <file>        Trigger eval set JSON (default: <skill-path>/evals/trigger-evals.json)
  --iterations <n>         Optimization iterations (default: 5)
  --train-split <f>        Train fraction (default: 0.6)
  --seed <n>               Deterministic shuffle seed (default: 1)
  --runs-per-query <n>     Runs per query for stochastic averaging (default: 3)
  --cwd <dir>              Working directory for agent runs (default: inferred project root)
  --model <pattern>        Optional model id or provider/model reference
  --thinking <level>       off | minimal | low | medium | high | xhigh
  --help                   Show this help

Output artifacts (under <workspace>/optimize-description/<run-id>/):
  - trigger-eval-results.json  Full results per iteration
  - description-history.json   Each tried description with train/test scores
  - best-description.txt       Winning description (selected by TEST score)
`);
}

function parseArgs(argv) {
	const options = {
		iterations: 5,
		trainSplit: 0.6,
		seed: 1,
		runsPerQuery: 3,
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

	if (options.iterations !== undefined) {
		options.iterations = Number.parseInt(String(options.iterations), 10);
	}
	if (options.trainSplit !== undefined) {
		options.trainSplit = Number.parseFloat(String(options.trainSplit));
	}
	if (options.seed !== undefined) {
		options.seed = Number.parseInt(String(options.seed), 10);
	}
	if (options.runsPerQuery !== undefined) {
		options.runsPerQuery = Number.parseInt(String(options.runsPerQuery), 10);
	}
	return options;
}

async function ensureDir(dirPath) {
	await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
	return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, text) {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, text, "utf8");
}

function inferProjectRootFromSkillPath(skillPath) {
	const parent = path.dirname(skillPath);
	const grandparent = path.dirname(parent);
	if (path.basename(parent) === "skills" && path.basename(grandparent) === ".pi") {
		return path.dirname(grandparent);
	}
	return path.dirname(skillPath);
}

// Deterministic PRNG. Mulberry32 — small, fast, well-distributed for shuffling.
function mulberry32(seed) {
	let state = seed >>> 0;
	return function () {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffleDeterministic(items, seed) {
	const rng = mulberry32(seed);
	const arr = items.slice();
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = arr[i];
		arr[i] = arr[j];
		arr[j] = tmp;
	}
	return arr;
}

function splitTrainTest(queries, trainSplit, seed) {
	const shuffled = shuffleDeterministic(queries, seed);
	const trainCount = Math.max(1, Math.min(shuffled.length - 1, Math.floor(shuffled.length * trainSplit)));
	return {
		train: shuffled.slice(0, trainCount).map((q) => ({ ...q, partition: "train" })),
		test: shuffled.slice(trainCount).map((q) => ({ ...q, partition: "test" })),
	};
}

async function discoverSingleSkill(pi, skillDir) {
	const result = pi.loadSkillsFromDir({ dir: skillDir, source: "sdk-optimize-description" });
	if (!result.skills || result.skills.length === 0) {
		throw new Error(`No skill discovered in ${skillDir}`);
	}
	if (result.skills.length > 1) {
		throw new Error(`Expected one skill in ${skillDir}, found ${result.skills.length}`);
	}
	return result.skills[0];
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

function chooseModel(modelRegistry, modelPattern) {
	if (!modelPattern) return { model: undefined, warning: undefined };
	const available = typeof modelRegistry.getAvailable === "function" ? modelRegistry.getAvailable() : [];
	if (!Array.isArray(available) || available.length === 0) {
		return { model: undefined, warning: `No available models found while resolving --model ${modelPattern}` };
	}
	const direct = available.find(
		(model) =>
			`${model.provider}/${model.id}` === modelPattern ||
			model.id === modelPattern ||
			model.name === modelPattern,
	);
	if (direct) return { model: direct, warning: undefined };
	const partial = available.filter(
		(model) =>
			`${model.provider}/${model.id}`.includes(modelPattern) ||
			model.id.includes(modelPattern) ||
			(model.name && model.name.includes(modelPattern)),
	);
	if (partial.length === 1) return { model: partial[0], warning: undefined };
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

// Trigger detection: walk the assistant message history for tool-call content
// blocks where the tool is `read` and the resolved path is under the skill
// directory. See references/sdk-spec.md, "Trigger detection".
//
// Pi's actual content-block shape (verified empirically against a real
// session): { type: "toolCall", id, name, arguments: { path: "..." } }.
// We also accept the Claude API shape { type: "tool_use", input: {...} } so
// the detector survives provider/runtime changes that normalize differently.
function findReadPathsInMessages(messages) {
	const paths = [];
	for (const message of messages ?? []) {
		if (!Array.isArray(message?.content)) continue;
		for (const item of message.content) {
			if (!item || typeof item !== "object") continue;
			if (item.type !== "toolCall" && item.type !== "tool_use") continue;
			if (item.name !== "read") continue;
			const args = item.arguments ?? item.input ?? {};
			const candidate = args.path ?? args.file_path ?? args.filePath ?? args.target_file;
			if (typeof candidate === "string" && candidate.length > 0) {
				paths.push(candidate);
			}
		}
	}
	return paths;
}

// Trigger detection: the model is considered to have applied the skill when
// (and only when) it issued a read against the skill's own SKILL.md file.
// Reading peripheral skill files (references/, evals/, scripts/) alone is too
// noisy: empirical calibration on 2026-05-30 showed the model often reads
// these files while researching the workspace without ever invoking the skill
// workflow. Tightening to SKILL.md eliminates that noise without missing real
// invocations for skills whose body is substantive enough to be necessary.
function isSkillMdRead(filePath, skillDir, sessionCwd) {
	if (typeof filePath !== "string" || filePath.length === 0) return false;
	const skillMdAbs = path.resolve(skillDir, "SKILL.md");
	const resolvedAbs = path.isAbsolute(filePath)
		? path.resolve(filePath)
		: path.resolve(sessionCwd, filePath);
	return resolvedAbs === skillMdAbs;
}

// Run one session for one query. Returns whether the model triggered the skill
// (by reading any file under the skill directory) and the list of read paths.
async function runQuerySession(pi, options) {
	const sessionManager = pi.SessionManager.inMemory(options.cwd);
	const { session } = await pi.createAgentSession({
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinking,
		resourceLoader: options.resourceLoader,
		sessionManager,
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	});

	let error;
	try {
		await session.prompt(options.query);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	const messages = session.agent?.state?.messages ?? [];
	const readPaths = findReadPathsInMessages(messages);
	const triggered = readPaths.some((p) => isSkillMdRead(p, options.skillDir, options.cwd));
	await session.dispose();

	return {
		triggered,
		signal_source: triggered ? "skill-md-read" : "no-skill-md-read",
		read_paths: readPaths,
		error: error ?? null,
	};
}

async function evaluateQuery(pi, query, options) {
	const runs = [];
	for (let i = 0; i < options.runsPerQuery; i++) {
		const result = await runQuerySession(pi, {
			cwd: options.cwd,
			model: options.model,
			thinking: options.thinking,
			resourceLoader: options.resourceLoader,
			skillDir: options.skillDir,
			query: query.query,
		});
		runs.push(result);
	}
	const successful = runs.filter((r) => !r.error);
	const triggeredCount = successful.filter((r) => r.triggered).length;
	const triggerRate = successful.length > 0 ? triggeredCount / successful.length : 0;
	const correct = query.should_trigger ? triggerRate >= 0.67 : triggerRate <= 0.33;
	return {
		query: query.query,
		should_trigger: query.should_trigger,
		partition: query.partition,
		runs,
		trigger_rate: Number(triggerRate.toFixed(3)),
		correct,
	};
}

async function evaluateDescription(pi, options) {
	const evaluations = [];
	for (const query of options.queries) {
		console.log(`  query (${query.partition}): "${query.query.slice(0, 60).replace(/\n/g, " ")}${query.query.length > 60 ? "…" : ""}"`);
		const evaluation = await evaluateQuery(pi, query, options);
		evaluations.push(evaluation);
		console.log(`    -> trigger_rate=${evaluation.trigger_rate} should=${evaluation.should_trigger} correct=${evaluation.correct}`);
	}
	return evaluations;
}

function computeScore(evaluations, partition) {
	const filtered = partition ? evaluations.filter((e) => e.partition === partition) : evaluations;
	if (filtered.length === 0) return 0;
	return Number((filtered.filter((e) => e.correct).length / filtered.length).toFixed(3));
}

function buildMetaPrompt(skill, currentDescription, failedShouldTrigger, failedShouldNotTrigger, passedCount) {
	const lines = [
		"You are revising the description field of a pi skill's frontmatter to improve trigger accuracy.",
		"",
		`Skill name: ${skill.name}`,
		`Current description: "${currentDescription}"`,
		"",
		"Skill body (for context):",
		"```",
		String(skill.content ?? "").slice(0, 3000),
		"```",
		"",
		"Trigger eval results on the training partition:",
		"",
		"[FAILED — should have triggered, but did not]",
	];
	if (failedShouldTrigger.length === 0) {
		lines.push("(none)");
	} else {
		for (const q of failedShouldTrigger) {
			lines.push(`- "${q.query}" (trigger_rate=${q.trigger_rate})`);
		}
	}
	lines.push("", "[FAILED — should not have triggered, but did]");
	if (failedShouldNotTrigger.length === 0) {
		lines.push("(none)");
	} else {
		for (const q of failedShouldNotTrigger) {
			lines.push(`- "${q.query}" (trigger_rate=${q.trigger_rate})`);
		}
	}
	lines.push(
		"",
		`[PASSED] ${passedCount} prompts handled correctly.`,
		"",
		"Your task: propose a revised description that:",
		"1. Is concise (under 1024 characters; ideally under 300)",
		"2. Says both WHAT the skill does AND WHEN to use it",
		"3. Adds language that pulls the model toward triggering on the under-triggering queries",
		"4. Adds disambiguating language that prevents the over-triggering false positives",
		"",
		"Respond with ONE JSON object only, no other text, no markdown code fences:",
		'{"description": "the revised description", "reasoning": "one sentence on what changed and why"}',
	);
	return lines.join("\n");
}

function extractJsonCandidate(text) {
	// Strip code fences if present, then scan for the first balanced { ... } block.
	const stripped = text
		.replace(/```json\s*/gi, "")
		.replace(/```\s*$/g, "")
		.trim();
	let depth = 0;
	let start = -1;
	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "{") {
			if (depth === 0) start = i;
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0 && start !== -1) {
				try {
					return JSON.parse(stripped.slice(start, i + 1));
				} catch {
					// Continue scanning
					start = -1;
				}
			}
		}
	}
	return null;
}

async function proposeDescription(pi, options) {
	const failedShouldTrigger = options.evaluations.filter(
		(e) => e.partition === "train" && e.should_trigger && !e.correct,
	);
	const failedShouldNotTrigger = options.evaluations.filter(
		(e) => e.partition === "train" && !e.should_trigger && !e.correct,
	);
	const passed = options.evaluations.filter((e) => e.partition === "train" && e.correct);

	const prompt = buildMetaPrompt(
		options.skill,
		options.currentDescription,
		failedShouldTrigger,
		failedShouldNotTrigger,
		passed.length,
	);

	const sessionManager = pi.SessionManager.inMemory(options.cwd);
	const { session } = await pi.createAgentSession({
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinking,
		resourceLoader: options.bareLoader,
		sessionManager,
		tools: [],
	});

	try {
		await session.prompt(prompt);
	} catch (e) {
		await session.dispose();
		throw new Error(`Description proposer session failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	const messages = session.agent?.state?.messages ?? [];
	const finalText = findLastAssistantText(messages);
	await session.dispose();

	const parsed = extractJsonCandidate(finalText);
	if (!parsed || typeof parsed.description !== "string" || parsed.description.trim().length === 0) {
		throw new Error(
			`Description proposer returned invalid JSON. Got: ${finalText.slice(0, 300)}${finalText.length > 300 ? "…" : ""}`,
		);
	}

	return {
		description: parsed.description.trim(),
		reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "no reasoning provided",
	};
}

function buildRunId() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}

	if (!options.skillPath) throw new Error("--skill-path is required");
	if (!options.workspace) throw new Error("--workspace is required");
	if (!Number.isInteger(options.iterations) || options.iterations < 0) {
		throw new Error("--iterations must be a non-negative integer");
	}
	if (!Number.isFinite(options.trainSplit) || options.trainSplit <= 0 || options.trainSplit >= 1) {
		throw new Error("--train-split must be a fraction strictly between 0 and 1");
	}
	if (!Number.isInteger(options.seed)) throw new Error("--seed must be an integer");
	if (!Number.isInteger(options.runsPerQuery) || options.runsPerQuery < 1) {
		throw new Error("--runs-per-query must be a positive integer");
	}

	const skillPath = path.resolve(String(options.skillPath));
	const workspacePath = path.resolve(String(options.workspace));
	const evalSetPath = path.resolve(
		String(options.evalSet ?? path.join(skillPath, "evals", "trigger-evals.json")),
	);
	const cwd = path.resolve(String(options.cwd ?? inferProjectRootFromSkillPath(skillPath)));
	const runId = buildRunId();
	const runDir = path.join(workspacePath, "optimize-description", runId);

	if (!existsSync(skillPath)) throw new Error(`Skill path does not exist: ${skillPath}`);
	if (!existsSync(evalSetPath)) {
		throw new Error(
			`Trigger eval set does not exist: ${evalSetPath}\n` +
				"Create one as a JSON array of { query, should_trigger } objects.",
		);
	}

	await ensureDir(runDir);

	const { pi } = await loadPiModules();
	const agentDir = typeof pi.getAgentDir === "function" ? pi.getAgentDir() : undefined;
	const authStorage = pi.AuthStorage.create();
	const modelRegistry = pi.ModelRegistry.create(authStorage);
	const modelChoice = chooseModel(modelRegistry, options.model ? String(options.model) : undefined);
	if (modelChoice.warning) console.warn(`[optimize-description] warning: ${modelChoice.warning}`);

	const evalSet = await readJson(evalSetPath);
	const queriesRaw = Array.isArray(evalSet) ? evalSet : evalSet.queries;
	if (!Array.isArray(queriesRaw) || queriesRaw.length === 0) {
		throw new Error(`Invalid trigger eval set: expected a non-empty array or { queries: [...] }`);
	}
	for (const q of queriesRaw) {
		if (typeof q?.query !== "string" || typeof q?.should_trigger !== "boolean") {
			throw new Error("Each trigger eval entry must be { query: string, should_trigger: boolean }");
		}
	}

	const { train, test } = splitTrainTest(queriesRaw, options.trainSplit, options.seed);
	const allQueries = [...train, ...test];
	console.log(
		`Trigger eval split: train=${train.length}, test=${test.length} (split=${options.trainSplit}, seed=${options.seed})`,
	);

	if (train.length === 0 || test.length === 0) {
		throw new Error(
			`Train or test partition is empty (train=${train.length}, test=${test.length}). ` +
				"Add more queries or adjust --train-split.",
		);
	}

	const originalSkill = await discoverSingleSkill(pi, skillPath);
	const baseSkillContent = originalSkill.content;
	const bareLoader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
	});
	await bareLoader.reload();

	const iterations = [];
	const descriptionHistory = [];
	let currentDescription = originalSkill.description;
	let currentSkill = { ...originalSkill };
	let bestByTest = { iteration: -1, description: originalSkill.description, train_score: 0, test_score: 0 };

	for (let iter = 0; iter <= options.iterations; iter++) {
		console.log(`\n=== Iteration ${iter}: "${currentDescription.slice(0, 80)}${currentDescription.length > 80 ? "…" : ""}" ===`);

		const skillForRun = { ...currentSkill, description: currentDescription, content: baseSkillContent };
		const loader = await createResourceLoader(pi, { cwd, agentDir, skill: skillForRun });

		const evaluations = await evaluateDescription(pi, {
			cwd,
			model: modelChoice.model,
			thinking: options.thinking,
			resourceLoader: loader,
			skillDir: skillPath,
			queries: allQueries,
			runsPerQuery: options.runsPerQuery,
		});

		if (typeof loader.dispose === "function") loader.dispose();

		const trainScore = computeScore(evaluations, "train");
		const testScore = computeScore(evaluations, "test");
		console.log(`  iteration ${iter}: train_score=${trainScore} test_score=${testScore}`);

		iterations.push({
			iteration: iter,
			description: currentDescription,
			train_score: trainScore,
			test_score: testScore,
			per_query: evaluations,
		});
		descriptionHistory.push({
			iteration: iter,
			description: currentDescription,
			train_score: trainScore,
			test_score: testScore,
			reasoning: iter === 0 ? "initial description" : descriptionHistory[descriptionHistory.length - 1]?.reasoning ?? "",
		});

		if (testScore > bestByTest.test_score) {
			bestByTest = { iteration: iter, description: currentDescription, train_score: trainScore, test_score: testScore };
		}

		if (iter === options.iterations) break;
		if (testScore >= 1 && trainScore >= 1) {
			console.log("  perfect score on both partitions — stopping early.");
			break;
		}

		console.log("  proposing revised description...");
		try {
			const proposal = await proposeDescription(pi, {
				cwd,
				model: modelChoice.model,
				thinking: options.thinking,
				bareLoader,
				skill: { ...currentSkill, description: currentDescription, content: baseSkillContent },
				currentDescription,
				evaluations,
			});
			currentDescription = proposal.description;
			currentSkill = { ...currentSkill, description: currentDescription };
			descriptionHistory[descriptionHistory.length - 1].reasoning = proposal.reasoning;
			console.log(`  proposed: "${proposal.description.slice(0, 80)}${proposal.description.length > 80 ? "…" : ""}"`);
		} catch (e) {
			console.error(`  proposer failed: ${e instanceof Error ? e.message : String(e)}`);
			console.log("  stopping iteration loop after proposer failure.");
			break;
		}
	}

	if (typeof bareLoader.dispose === "function") bareLoader.dispose();

	const triggerEvalResults = {
		generated_at: new Date().toISOString(),
		skill_path: skillPath,
		skill_name: originalSkill.name,
		model: modelChoice.model ? `${modelChoice.model.provider}/${modelChoice.model.id}` : null,
		thinking: options.thinking ?? null,
		train_split: options.trainSplit,
		seed: options.seed,
		runs_per_query: options.runsPerQuery,
		eval_set_size: queriesRaw.length,
		train_size: train.length,
		test_size: test.length,
		iterations,
		best_iteration: bestByTest.iteration,
		best_description: bestByTest.description,
		best_train_score: bestByTest.train_score,
		best_test_score: bestByTest.test_score,
	};

	await writeJson(path.join(runDir, "trigger-eval-results.json"), triggerEvalResults);
	await writeJson(path.join(runDir, "description-history.json"), {
		skill_path: skillPath,
		generated_at: new Date().toISOString(),
		history: descriptionHistory,
	});
	await writeText(path.join(runDir, "best-description.txt"), `${bestByTest.description}\n`);

	console.log("");
	console.log(`Optimization complete.`);
	console.log(`  run dir: ${runDir}`);
	console.log(`  best iteration: ${bestByTest.iteration}`);
	console.log(`  best train_score: ${bestByTest.train_score}`);
	console.log(`  best test_score:  ${bestByTest.test_score}`);
	console.log(`  best description: ${bestByTest.description}`);
}

main().catch((error) => {
	console.error(`[optimize-description] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
