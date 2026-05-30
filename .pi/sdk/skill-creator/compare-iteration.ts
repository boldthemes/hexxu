#!/usr/bin/env -S node --experimental-strip-types

const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FALLBACK_PI_MODULE =
	"/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const FALLBACK_PI_AI_MODULE =
	"/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";

const TEXT_FILE_EXTENSIONS = new Set([
	".md",
	".txt",
	".json",
	".yaml",
	".yml",
	".csv",
	".tsv",
	".html",
	".xml",
	".js",
	".ts",
]);

const MAX_FILES_PER_RUN = 8;
const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_RUN_CHARS = 18000;

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
  compare-iteration.ts --iteration-path <dir> [options]

Options:
  --iteration-path <dir>          Iteration directory to compare (required)
  --previous-iteration <dir>      Optional previous iteration directory for cross-iteration blind comparison
  --eval-set <file>               Optional evals.json fallback for expectations
  --output-summary <file>         Output path for blind-comparison-summary.json (default: <iteration-path>/blind-comparison-summary.json)
  --output-vs-previous-summary <file>
                                  Output path for blind-comparison-vs-previous-summary.json
                                  (default: <iteration-path>/blind-comparison-vs-previous-summary.json when --previous-iteration is used)
  --model <pattern>               Optional model id or provider/model reference
  --thinking <level>              off | minimal | low | medium | high | xhigh
  --help                          Show this help
`);
}

function parseArgs(argv) {
	const options = {};
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
	return options;
}

async function ensureDir(dirPath) {
	await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
	const raw = await fs.readFile(filePath, "utf8");
	return JSON.parse(raw);
}

async function readText(filePath) {
	return await fs.readFile(filePath, "utf8");
}

async function writeJson(filePath, value) {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, text) {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, text, "utf8");
}

async function listSubdirectories(dirPath) {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dirPath, entry.name));
}

async function listFilesRecursive(rootPath) {
	if (!existsSync(rootPath)) return [];
	const files = [];
	const entries = await fs.readdir(rootPath, { withFileTypes: true });
	for (const entry of entries) {
		const absolutePath = path.join(rootPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFilesRecursive(absolutePath)));
		} else {
			files.push(absolutePath);
		}
	}
	return files;
}

async function findRunDirs(configurationDir) {
	const directRunJson = path.join(configurationDir, "run.json");
	if (existsSync(directRunJson)) {
		return [configurationDir];
	}
	const children = await listSubdirectories(configurationDir);
	return children.filter((child) => existsSync(path.join(child, "run.json")));
}

function normalizeText(value) {
	return String(value ?? "").replace(/\r\n/g, "\n");
}

function sanitizeNamePart(value) {
	return String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "item";
}

function isTextFile(filePath) {
	return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function excerpt(text, maxChars) {
	const normalized = normalizeText(text);
	if (normalized.length <= maxChars) {
		return { text: normalized, truncated: false };
	}
	return {
		text: `${normalized.slice(0, maxChars)}\n\n[truncated]`,
		truncated: true,
	};
}

function average(numbers) {
	const valid = numbers.filter((value) => typeof value === "number" && Number.isFinite(value));
	if (valid.length === 0) return null;
	return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(3));
}

function hashString(value) {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
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
			skills: [],
			diagnostics: [],
		}),
	});
	await loader.reload();
	return loader;
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

async function runComparatorSession(pi, sessionOptions) {
	const sessionManager = pi.SessionManager.inMemory(sessionOptions.cwd);
	const { session } = await pi.createAgentSession({
		cwd: sessionOptions.cwd,
		model: sessionOptions.model,
		thinkingLevel: sessionOptions.thinking,
		resourceLoader: sessionOptions.resourceLoader,
		sessionManager,
		tools: [],
	});

	let success = true;
	let errorMessage;
	try {
		await session.prompt(sessionOptions.prompt);
	} catch (error) {
		success = false;
		errorMessage = error instanceof Error ? error.message : String(error);
	}

	const messages = session.agent?.state?.messages ?? [];
	const finalAssistantText = findLastAssistantText(messages);
	await session.dispose();
	return {
		success,
		errorMessage,
		messages,
		finalAssistantText,
	};
}

function buildEvalSetLookup(evalSet) {
	const byId = new Map();
	const byName = new Map();
	if (!evalSet || !Array.isArray(evalSet.evals)) return { byId, byName };
	for (const evalEntry of evalSet.evals) {
		if (evalEntry.id !== undefined) byId.set(String(evalEntry.id), evalEntry);
		if (evalEntry.name) byName.set(String(evalEntry.name), evalEntry);
	}
	return { byId, byName };
}

function deriveExpectations(evalMetadata, lookup) {
	if (Array.isArray(evalMetadata.expectations) && evalMetadata.expectations.length > 0) {
		return evalMetadata.expectations.map((item) => String(item));
	}

	const fallback = (evalMetadata.evalId !== undefined && lookup.byId.get(String(evalMetadata.evalId))) ||
		(evalMetadata.evalName ? lookup.byName.get(String(evalMetadata.evalName)) : undefined);
	if (fallback && Array.isArray(fallback.expectations)) {
		return fallback.expectations.map((item) => String(item));
	}

	return [];
}

async function loadRunBundle(runDir) {
	const runJson = existsSync(path.join(runDir, "run.json")) ? await readJson(path.join(runDir, "run.json")) : {};
	const metrics = existsSync(path.join(runDir, "metrics.json")) ? await readJson(path.join(runDir, "metrics.json")) : {};
	const timing = existsSync(path.join(runDir, "timing.json")) ? await readJson(path.join(runDir, "timing.json")) : {};
	const outputDir = path.join(runDir, "outputs");
	const candidateFiles = (await listFilesRecursive(outputDir))
		.filter((filePath) => isTextFile(filePath))
		.sort((left, right) => {
			const leftIsAssistant = path.basename(left) === "assistant-final.md" ? -1 : 0;
			const rightIsAssistant = path.basename(right) === "assistant-final.md" ? -1 : 0;
			if (leftIsAssistant !== rightIsAssistant) return leftIsAssistant - rightIsAssistant;
			return left.localeCompare(right);
		});

	const textArtifacts = [];
	let remainingChars = MAX_TOTAL_RUN_CHARS;
	for (const filePath of candidateFiles.slice(0, MAX_FILES_PER_RUN)) {
		if (remainingChars <= 0) break;
		const rawText = await readText(filePath);
		const clipped = excerpt(rawText, Math.min(MAX_FILE_CHARS, remainingChars));
		textArtifacts.push({
			path: path.relative(runDir, filePath).split(path.sep).join("/"),
			chars: rawText.length,
			truncated: clipped.truncated,
			text: clipped.text,
		});
		remainingChars -= clipped.text.length;
	}

	const gradingPath = path.join(runDir, "grading.json");
	const grading = existsSync(gradingPath) ? await readJson(gradingPath) : undefined;

	return {
		runDir,
		configuration: runJson.configuration ?? path.basename(path.dirname(runDir)) ?? path.basename(runDir),
		runNumber: runJson.runNumber ?? 1,
		success: Boolean(runJson.success),
		errorMessage: runJson.errorMessage ?? null,
		durationSeconds:
			typeof timing.totalDurationSeconds === "number"
				? timing.totalDurationSeconds
				: typeof timing.durationMs === "number"
					? Number((timing.durationMs / 1000).toFixed(3))
					: null,
		messageCount: typeof metrics.messageCount === "number" ? metrics.messageCount : null,
		finalAssistantChars:
			typeof metrics.finalAssistantChars === "number"
				? metrics.finalAssistantChars
				: typeof runJson.finalAssistantChars === "number"
					? runJson.finalAssistantChars
					: null,
		textArtifacts,
		gradingSummary: grading?.summary ?? null,
	};
}

async function discoverConfigurations(evalDir) {
	const configurations = [];
	for (const configurationDir of await listSubdirectories(evalDir)) {
		const runDirs = await findRunDirs(configurationDir);
		if (runDirs.length === 0) continue;
		const runs = [];
		for (const runDir of runDirs) {
			runs.push(await loadRunBundle(runDir));
		}
		runs.sort((left, right) => left.runNumber - right.runNumber);
		configurations.push({
			name: path.basename(configurationDir),
			runs,
		});
	}
	configurations.sort((left, right) => left.name.localeCompare(right.name));
	return configurations;
}

function buildEvalLookupKeys(evalMetadata, evalDir) {
	const keys = [];
	if (evalMetadata?.evalId !== undefined && evalMetadata?.evalId !== null) {
		keys.push(`id:${String(evalMetadata.evalId)}`);
	}
	if (typeof evalMetadata?.evalName === "string" && evalMetadata.evalName.trim()) {
		keys.push(`name:${evalMetadata.evalName.trim()}`);
	}
	keys.push(`dir:${path.basename(evalDir)}`);
	return [...new Set(keys)];
}

async function discoverEvalBundles(iterationPath) {
	const evalDirs = (await listSubdirectories(iterationPath)).filter((dir) => path.basename(dir).startsWith("eval-"));
	const bundles = [];
	for (const evalDir of evalDirs) {
		const evalMetadataPath = path.join(evalDir, "eval_metadata.json");
		const evalMetadata = existsSync(evalMetadataPath) ? await readJson(evalMetadataPath) : {};
		bundles.push({
			evalDir,
			evalMetadata,
			lookupKeys: buildEvalLookupKeys(evalMetadata, evalDir),
			configurations: await discoverConfigurations(evalDir),
		});
	}
	return bundles;
}

function buildEvalBundleLookup(bundles) {
	const lookup = new Map();
	for (const bundle of bundles) {
		for (const key of bundle.lookupKeys) {
			if (!lookup.has(key)) {
				lookup.set(key, bundle);
			}
		}
	}
	return lookup;
}

function findMatchingEvalBundle(bundleLookup, currentBundle) {
	for (const key of currentBundle.lookupKeys) {
		if (bundleLookup.has(key)) {
			return bundleLookup.get(key);
		}
	}
	return undefined;
}

function pairRuns(leftConfig, rightConfig) {
	const leftByRun = new Map(leftConfig.runs.map((run) => [String(run.runNumber), run]));
	const rightByRun = new Map(rightConfig.runs.map((run) => [String(run.runNumber), run]));
	const sharedRunNumbers = [...leftByRun.keys()].filter((runNumber) => rightByRun.has(runNumber)).sort((a, b) => Number(a) - Number(b));
	if (sharedRunNumbers.length > 0) {
		return sharedRunNumbers.map((runNumber) => ({
			runNumber: Number(runNumber),
			leftRun: leftByRun.get(runNumber),
			rightRun: rightByRun.get(runNumber),
			pairing: "matched-run-number",
		}));
	}

	const count = Math.min(leftConfig.runs.length, rightConfig.runs.length);
	const pairs = [];
	for (let i = 0; i < count; i++) {
		pairs.push({
			runNumber: Math.max(leftConfig.runs[i]?.runNumber ?? i + 1, rightConfig.runs[i]?.runNumber ?? i + 1),
			leftRun: leftConfig.runs[i],
			rightRun: rightConfig.runs[i],
			pairing: "paired-by-index",
		});
	}
	return pairs;
}

function renderRunBundle(label, bundle) {
	const lines = [
		`Output ${label}`,
		`- reported status: ${bundle.success ? "success" : "failure"}`,
		`- duration seconds: ${bundle.durationSeconds ?? "n/a"}`,
		`- message count: ${bundle.messageCount ?? "n/a"}`,
		`- final assistant chars: ${bundle.finalAssistantChars ?? "n/a"}`,
	];

	if (bundle.gradingSummary) {
		lines.push(
			`- heuristic expectation pass rate: ${bundle.gradingSummary.pass_rate ?? "n/a"}`,
			`- heuristic expectations passed: ${bundle.gradingSummary.passed ?? "n/a"}/${bundle.gradingSummary.total ?? "n/a"}`,
		);
	}

	if (bundle.textArtifacts.length === 0) {
		lines.push("- no text output files were found under outputs/");
		return lines.join("\n");
	}

	lines.push("", "Text outputs:");
	for (const artifact of bundle.textArtifacts) {
		lines.push(`\n### ${artifact.path}${artifact.truncated ? " (truncated)" : ""}`);
		lines.push(artifact.text || "[empty]");
	}
	return lines.join("\n");
}

function buildComparatorPrompt(evalMetadata, expectations, aBundle, bBundle) {
	const lines = [
		"You are a blind comparator for skill eval outputs.",
		"Judge the outputs only by task completion and output quality. Do not speculate about which hidden configuration produced A or B.",
		"Be decisive. Ties should be rare.",
		"Return ONLY valid JSON with no markdown fences.",
		"",
		"Required JSON shape:",
		'{',
		'  "winner": "A" | "B" | "TIE",',
		'  "reasoning": "short explanation",',
		'  "rubric": {',
		'    "A": {',
		'      "content": { "correctness": 1-5, "completeness": 1-5, "accuracy": 1-5 },',
		'      "structure": { "organization": 1-5, "formatting": 1-5, "usability": 1-5 },',
		'      "content_score": number,',
		'      "structure_score": number,',
		'      "overall_score": number',
		'    },',
		'    "B": {',
		'      "content": { "correctness": 1-5, "completeness": 1-5, "accuracy": 1-5 },',
		'      "structure": { "organization": 1-5, "formatting": 1-5, "usability": 1-5 },',
		'      "content_score": number,',
		'      "structure_score": number,',
		'      "overall_score": number',
		'    }',
		'  },',
		'  "output_quality": {',
		'    "A": { "score": number, "strengths": [string], "weaknesses": [string] },',
		'    "B": { "score": number, "strengths": [string], "weaknesses": [string] }',
		'  },',
		'  "expectation_results": {',
		'    "A": { "passed": number, "total": number, "pass_rate": number, "details": [{ "text": string, "passed": boolean }] },',
		'    "B": { "passed": number, "total": number, "pass_rate": number, "details": [{ "text": string, "passed": boolean }] }',
		'  }',
		'}',
		"If no expectations are provided, you may omit expectation_results.",
		"",
		"Primary decision rule:",
		"1. Overall rubric quality.",
		"2. Expectation satisfaction as secondary evidence.",
		"3. If both are truly indistinguishable, choose TIE.",
		"",
		"Eval prompt:",
		normalizeText(evalMetadata.prompt ?? ""),
	];

	if (evalMetadata.expectedOutput) {
		lines.push("", "Expected outcome:", normalizeText(evalMetadata.expectedOutput));
	}

	if (expectations.length > 0) {
		lines.push("", "Expectations:");
		for (const expectation of expectations) {
			lines.push(`- ${expectation}`);
		}
	}

	lines.push("", renderRunBundle("A", aBundle), "", renderRunBundle("B", bBundle));
	return lines.join("\n");
}

function extractJsonCandidate(rawText) {
	const trimmed = String(rawText ?? "").trim();
	if (!trimmed) return undefined;

	const direct = (() => {
		try {
			return JSON.parse(trimmed);
		} catch (_error) {
			return undefined;
		}
	})();
	if (direct && typeof direct === "object") return direct;

	const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fencedMatch) {
		try {
			return JSON.parse(fencedMatch[1].trim());
		} catch (_error) {
			// ignore and keep trying
		}
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
		const candidate = trimmed.slice(firstBrace, lastBrace + 1);
		try {
			return JSON.parse(candidate);
		} catch (_error) {
			return undefined;
		}
	}

	return undefined;
}

function normalizePassRate(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value > 1 && value <= 100) {
		return Number((value / 100).toFixed(3));
	}
	return Number(value.toFixed(3));
}

function normalizeExpectationBucket(bucket) {
	if (!bucket || typeof bucket !== "object") return bucket ?? null;
	return {
		passed: typeof bucket.passed === "number" ? bucket.passed : null,
		total: typeof bucket.total === "number" ? bucket.total : null,
		pass_rate: normalizePassRate(bucket.pass_rate),
		details: Array.isArray(bucket.details)
			? bucket.details.map((detail) => ({
				text: typeof detail?.text === "string" ? detail.text : "",
				passed: Boolean(detail?.passed),
			}))
			: [],
	};
}

function normalizeComparatorResult(parsed) {
	if (!parsed || typeof parsed !== "object") return parsed;
	const winner = parsed.winner === "A" || parsed.winner === "B" || parsed.winner === "TIE" ? parsed.winner : "TIE";
	return {
		...parsed,
		winner,
		reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
		expectation_results:
			parsed.expectation_results && typeof parsed.expectation_results === "object"
				? {
					A: normalizeExpectationBucket(parsed.expectation_results.A),
					B: normalizeExpectationBucket(parsed.expectation_results.B),
				}
				: undefined,
	};
}

function resolveWinner(winner, labelMap) {
	if (winner === "A") return labelMap.A.entityKey;
	if (winner === "B") return labelMap.B.entityKey;
	if (winner === "TIE") return "tie";
	return null;
}

function buildConfigurationStats(configurationNames, comparisonSummaries) {
	const stats = new Map(configurationNames.map((name) => [name, { configuration: name, wins: 0, losses: 0, ties: 0, comparisons: 0, win_rate: null }]));

	for (const comparison of comparisonSummaries) {
		const left = stats.get(comparison.left_configuration);
		const right = stats.get(comparison.right_configuration);
		if (!left || !right || !comparison.success) continue;

		left.comparisons += 1;
		right.comparisons += 1;

		if (comparison.resolved_winner === "tie") {
			left.ties += 1;
			right.ties += 1;
			continue;
		}
		if (comparison.resolved_winner === comparison.left_key) {
			left.wins += 1;
			right.losses += 1;
			continue;
		}
		if (comparison.resolved_winner === comparison.right_key) {
			right.wins += 1;
			left.losses += 1;
		}
	}

	return [...stats.values()]
		.map((entry) => ({
			...entry,
			win_rate: entry.comparisons > 0 ? Number((entry.wins / entry.comparisons).toFixed(3)) : null,
		}))
		.sort((left, right) => {
			if (right.wins !== left.wins) return right.wins - left.wins;
			const leftRate = left.win_rate ?? -1;
			const rightRate = right.win_rate ?? -1;
			if (rightRate !== leftRate) return rightRate - leftRate;
			return left.configuration.localeCompare(right.configuration);
		});
}

function chooseOverallWinner(stats) {
	if (stats.length === 0) return "tie";
	if (stats.length === 1) return stats[0].configuration;
	const [first, second] = stats;
	if (second && first.wins === second.wins && (first.win_rate ?? -1) === (second.win_rate ?? -1)) {
		return "tie";
	}
	return first.configuration;
}

function chooseHeadToHeadWinner(currentWins, previousWins) {
	if (currentWins === previousWins) return "tie";
	return currentWins > previousWins ? "current" : "previous";
}

function buildAgainstPreviousStats(configurationNames, comparisonSummaries) {
	const stats = new Map(
		configurationNames.map((name) => [
			name,
			{
				configuration: name,
				current_wins: 0,
				previous_wins: 0,
				ties: 0,
				comparisons: 0,
				current_win_rate: null,
				previous_win_rate: null,
				winner: "tie",
			},
		]),
	);

	for (const comparison of comparisonSummaries) {
		const entry = stats.get(comparison.comparison_group);
		if (!entry || !comparison.success) continue;
		entry.comparisons += 1;
		if (comparison.resolved_winner === "current") {
			entry.current_wins += 1;
			continue;
		}
		if (comparison.resolved_winner === "previous") {
			entry.previous_wins += 1;
			continue;
		}
		if (comparison.resolved_winner === "tie") {
			entry.ties += 1;
		}
	}

	return [...stats.values()]
		.map((entry) => ({
			...entry,
			current_win_rate: entry.comparisons > 0 ? Number((entry.current_wins / entry.comparisons).toFixed(3)) : null,
			previous_win_rate: entry.comparisons > 0 ? Number((entry.previous_wins / entry.comparisons).toFixed(3)) : null,
			winner: chooseHeadToHeadWinner(entry.current_wins, entry.previous_wins),
		}))
		.sort((left, right) => {
			if (right.current_wins !== left.current_wins) return right.current_wins - left.current_wins;
			const leftRate = left.current_win_rate ?? -1;
			const rightRate = right.current_win_rate ?? -1;
			if (rightRate !== leftRate) return rightRate - leftRate;
			return left.configuration.localeCompare(right.configuration);
		});
}

function buildAgainstPreviousOverall(stats) {
	const aggregate = stats.reduce(
		(acc, entry) => {
			acc.current_wins += entry.current_wins;
			acc.previous_wins += entry.previous_wins;
			acc.ties += entry.ties;
			acc.comparisons += entry.comparisons;
			return acc;
		},
		{ current_wins: 0, previous_wins: 0, ties: 0, comparisons: 0 },
	);
	return {
		...aggregate,
		current_win_rate: aggregate.comparisons > 0 ? Number((aggregate.current_wins / aggregate.comparisons).toFixed(3)) : null,
		previous_win_rate: aggregate.comparisons > 0 ? Number((aggregate.previous_wins / aggregate.comparisons).toFixed(3)) : null,
		winner: chooseHeadToHeadWinner(aggregate.current_wins, aggregate.previous_wins),
	};
}

async function compareRunPair(pi, resourceLoader, options) {
	const artifactDir = options.artifactDir ?? path.join(options.evalDir, "blind-comparisons");
	const pairId =
		options.comparisonId ?? `${sanitizeNamePart(options.leftRun.configuration)}-vs-${sanitizeNamePart(options.rightRun.configuration)}-run-${options.runNumber}`;
	const artifactPath = path.join(artifactDir, `${pairId}.json`);
	const rawOutputPath = path.join(artifactDir, `${pairId}.raw.md`);
	const leftKey = options.leftKey ?? options.leftRun.configuration;
	const rightKey = options.rightKey ?? options.rightRun.configuration;
	const swapLabels = hashString(`${artifactDir}|${pairId}`) % 2 === 1;
	const leftLabel = {
		entityKey: leftKey,
		configuration: options.leftRun.configuration,
		runNumber: options.leftRun.runNumber,
		runDir: options.leftRun.runDir,
		...(options.leftLabelExtra ?? {}),
	};
	const rightLabel = {
		entityKey: rightKey,
		configuration: options.rightRun.configuration,
		runNumber: options.rightRun.runNumber,
		runDir: options.rightRun.runDir,
		...(options.rightLabelExtra ?? {}),
	};
	const labelMap = swapLabels ? { A: rightLabel, B: leftLabel } : { A: leftLabel, B: rightLabel };

	const aBundle = labelMap.A.entityKey === leftKey ? options.leftRun : options.rightRun;
	const bBundle = labelMap.B.entityKey === rightKey ? options.rightRun : options.leftRun;
	const prompt = buildComparatorPrompt(options.evalMetadata, options.expectations, aBundle, bBundle);
	const result = await runComparatorSession(pi, {
		cwd: options.cwd,
		model: options.model,
		thinking: options.thinking,
		resourceLoader,
		prompt,
	});

	await writeText(rawOutputPath, `${result.finalAssistantText || ""}\n`);

	if (!result.success) {
		const artifact = {
			generated_at: new Date().toISOString(),
			scope: options.scope ?? "within-iteration",
			eval_id: options.evalMetadata.evalId ?? null,
			eval_name: options.evalMetadata.evalName ?? null,
			comparison_id: pairId,
			comparison_group: options.comparisonGroup ?? null,
			model: options.modelId ?? null,
			thinking: options.thinking ?? null,
			pairing: options.pairing,
			labels: labelMap,
			success: false,
			error: result.errorMessage ?? "Comparator session failed",
			raw_model_output_path: rawOutputPath,
		};
		await writeJson(artifactPath, artifact);
		return {
			artifactPath,
			rawOutputPath,
			success: false,
			left_key: leftKey,
			right_key: rightKey,
			left_configuration: options.leftRun.configuration,
			right_configuration: options.rightRun.configuration,
			comparison_group: options.comparisonGroup ?? null,
			run_number: options.runNumber,
			resolved_winner: null,
			reasoning: artifact.error,
		};
	}

	const parsed = extractJsonCandidate(result.finalAssistantText);
	if (!parsed || typeof parsed !== "object") {
		const artifact = {
			generated_at: new Date().toISOString(),
			scope: options.scope ?? "within-iteration",
			eval_id: options.evalMetadata.evalId ?? null,
			eval_name: options.evalMetadata.evalName ?? null,
			comparison_id: pairId,
			comparison_group: options.comparisonGroup ?? null,
			model: options.modelId ?? null,
			thinking: options.thinking ?? null,
			pairing: options.pairing,
			labels: labelMap,
			success: false,
			error: "Comparator did not return parseable JSON",
			raw_model_output_path: rawOutputPath,
		};
		await writeJson(artifactPath, artifact);
		return {
			artifactPath,
			rawOutputPath,
			success: false,
			left_key: leftKey,
			right_key: rightKey,
			left_configuration: options.leftRun.configuration,
			right_configuration: options.rightRun.configuration,
			comparison_group: options.comparisonGroup ?? null,
			run_number: options.runNumber,
			resolved_winner: null,
			reasoning: artifact.error,
		};
	}

	const normalized = normalizeComparatorResult(parsed);
	const resolved = resolveWinner(normalized.winner, labelMap);
	const artifact = {
		generated_at: new Date().toISOString(),
		scope: options.scope ?? "within-iteration",
		eval_id: options.evalMetadata.evalId ?? null,
		eval_name: options.evalMetadata.evalName ?? null,
		comparison_id: pairId,
		comparison_group: options.comparisonGroup ?? null,
		model: options.modelId ?? null,
		thinking: options.thinking ?? null,
		pairing: options.pairing,
		labels: labelMap,
		success: true,
		winner: normalized.winner,
		resolved_winner: resolved,
		reasoning: normalized.reasoning,
		rubric: normalized.rubric ?? null,
		output_quality: normalized.output_quality ?? null,
		expectation_results: normalized.expectation_results ?? null,
		raw_model_output_path: rawOutputPath,
	};
	await writeJson(artifactPath, artifact);
	return {
		artifactPath,
		rawOutputPath,
		success: true,
		left_key: leftKey,
		right_key: rightKey,
		left_configuration: options.leftRun.configuration,
		right_configuration: options.rightRun.configuration,
		comparison_group: options.comparisonGroup ?? null,
		run_number: options.runNumber,
		resolved_winner: resolved,
		reasoning: artifact.reasoning,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}
	if (!options.iterationPath) {
		throw new Error("--iteration-path is required");
	}

	const iterationPath = path.resolve(String(options.iterationPath));
	if (!existsSync(iterationPath)) {
		throw new Error(`Iteration path does not exist: ${iterationPath}`);
	}

	const evalSet = options.evalSet && existsSync(path.resolve(String(options.evalSet)))
		? await readJson(path.resolve(String(options.evalSet)))
		: undefined;
	const lookup = buildEvalSetLookup(evalSet);
	const iterationJsonPath = path.join(iterationPath, "iteration.json");
	const iterationJson = existsSync(iterationJsonPath) ? await readJson(iterationJsonPath) : {};
	const cwd = typeof iterationJson.cwd === "string" && iterationJson.cwd ? path.resolve(iterationJson.cwd) : iterationPath;

	const { pi } = await loadPiModules();
	const agentDir = typeof pi.getAgentDir === "function" ? pi.getAgentDir() : undefined;
	const authStorage = pi.AuthStorage.create();
	const modelRegistry = pi.ModelRegistry.create(authStorage);
	const modelChoice = chooseModel(modelRegistry, options.model ? String(options.model) : undefined);
	if (modelChoice.warning) {
		console.warn(`[compare-iteration] warning: ${modelChoice.warning}`);
	}
	const modelId = modelChoice.model ? `${modelChoice.model.provider}/${modelChoice.model.id}` : null;
	const resourceLoader = await createResourceLoader(pi, { cwd, agentDir });

	const previousIterationPath = options.previousIteration ? path.resolve(String(options.previousIteration)) : undefined;
	if (previousIterationPath && previousIterationPath === iterationPath) {
		throw new Error("--previous-iteration must point to a different iteration directory");
	}
	if (previousIterationPath && !existsSync(previousIterationPath)) {
		throw new Error(`Previous iteration path does not exist: ${previousIterationPath}`);
	}

	const currentBundles = await discoverEvalBundles(iterationPath);
	const previousBundles = previousIterationPath ? await discoverEvalBundles(previousIterationPath) : [];
	const previousBundleLookup = buildEvalBundleLookup(previousBundles);
	const evalSummaries = [];
	const againstPreviousEvalSummaries = [];

	for (const currentBundle of currentBundles) {
		const { evalDir, evalMetadata, configurations } = currentBundle;
		const expectations = deriveExpectations(evalMetadata, lookup);
		const comparisonSummaries = [];

		for (let i = 0; i < configurations.length; i++) {
			for (let j = i + 1; j < configurations.length; j++) {
				const leftConfig = configurations[i];
				const rightConfig = configurations[j];
				for (const pair of pairRuns(leftConfig, rightConfig)) {
					if (!pair.leftRun || !pair.rightRun) continue;
					comparisonSummaries.push(
						await compareRunPair(pi, resourceLoader, {
							cwd,
							model: modelChoice.model,
							modelId,
							thinking: options.thinking ?? null,
							evalDir,
							evalMetadata,
							expectations,
							leftRun: pair.leftRun,
							rightRun: pair.rightRun,
							runNumber: pair.runNumber,
							pairing: pair.pairing,
							scope: "within-iteration",
							comparisonGroup: leftConfig.name,
						}),
					);
				}
			}
		}

		const configurationStats = buildConfigurationStats(
			configurations.map((configuration) => configuration.name),
			comparisonSummaries,
		);
		const evalSummary = {
			generated_at: new Date().toISOString(),
			eval_id: evalMetadata.evalId ?? null,
			eval_name: evalMetadata.evalName ?? path.basename(evalDir),
			model: modelId,
			thinking: options.thinking ?? null,
			comparison_count: comparisonSummaries.length,
			successful_comparisons: comparisonSummaries.filter((item) => item.success).length,
			failed_comparisons: comparisonSummaries.filter((item) => !item.success).length,
			overall_winner: chooseOverallWinner(configurationStats),
			by_configuration: configurationStats,
			comparisons: comparisonSummaries,
		};
		const evalOutputPath = path.join(evalDir, "blind-comparison.json");
		await writeJson(evalOutputPath, evalSummary);
		evalSummaries.push({
			eval_id: evalSummary.eval_id,
			eval_name: evalSummary.eval_name,
			summary_path: evalOutputPath,
			comparison_count: evalSummary.comparison_count,
			successful_comparisons: evalSummary.successful_comparisons,
			failed_comparisons: evalSummary.failed_comparisons,
			overall_winner: evalSummary.overall_winner,
			by_configuration: evalSummary.by_configuration,
		});

		if (previousIterationPath) {
			const previousBundle = findMatchingEvalBundle(previousBundleLookup, currentBundle);
			const previousComparisonSummaries = [];
			const matchedConfigurations = [];
			const missingConfigurationsInPrevious = [];
			const previousConfigByName = new Map(previousBundle?.configurations?.map((configuration) => [configuration.name, configuration]) ?? []);

			for (const currentConfig of configurations) {
				const previousConfig = previousConfigByName.get(currentConfig.name);
				if (!previousConfig) {
					missingConfigurationsInPrevious.push(currentConfig.name);
					continue;
				}
				matchedConfigurations.push(currentConfig.name);
				for (const pair of pairRuns(currentConfig, previousConfig)) {
					if (!pair.leftRun || !pair.rightRun) continue;
					previousComparisonSummaries.push(
						await compareRunPair(pi, resourceLoader, {
							cwd,
							model: modelChoice.model,
							modelId,
							thinking: options.thinking ?? null,
							evalDir,
							evalMetadata,
							expectations,
							leftRun: pair.leftRun,
							rightRun: pair.rightRun,
							runNumber: pair.runNumber,
							pairing: pair.pairing,
							scope: "vs-previous-iteration",
							artifactDir: path.join(evalDir, "blind-comparisons-vs-previous"),
							comparisonId: `${sanitizeNamePart(currentConfig.name)}-current-vs-previous-run-${pair.runNumber}`,
							comparisonGroup: currentConfig.name,
							leftKey: "current",
							rightKey: "previous",
							leftLabelExtra: { side: "current", iterationPath },
							rightLabelExtra: { side: "previous", iterationPath: previousIterationPath },
						}),
					);
				}
			}

			const againstPreviousStats = buildAgainstPreviousStats(matchedConfigurations, previousComparisonSummaries);
			const againstPreviousOverall = buildAgainstPreviousOverall(againstPreviousStats);
			const againstPreviousSummary = {
				generated_at: new Date().toISOString(),
				scope: "vs-previous-iteration",
				iteration_path: iterationPath,
				previous_iteration_path: previousIterationPath,
				eval_id: evalMetadata.evalId ?? null,
				eval_name: evalMetadata.evalName ?? path.basename(evalDir),
				previous_eval_found: Boolean(previousBundle),
				comparison_count: previousComparisonSummaries.length,
				successful_comparisons: previousComparisonSummaries.filter((item) => item.success).length,
				failed_comparisons: previousComparisonSummaries.filter((item) => !item.success).length,
				current_wins: againstPreviousOverall.current_wins,
				previous_wins: againstPreviousOverall.previous_wins,
				ties: againstPreviousOverall.ties,
				current_win_rate: againstPreviousOverall.current_win_rate,
				previous_win_rate: againstPreviousOverall.previous_win_rate,
				overall_winner: againstPreviousOverall.winner,
				matched_configurations: matchedConfigurations,
				missing_configurations_in_previous: [...new Set(missingConfigurationsInPrevious)].sort(),
				by_configuration: againstPreviousStats,
				comparisons: previousComparisonSummaries,
			};
			const againstPreviousOutputPath = path.join(evalDir, "blind-comparison-vs-previous.json");
			await writeJson(againstPreviousOutputPath, againstPreviousSummary);
			againstPreviousEvalSummaries.push({
				eval_id: againstPreviousSummary.eval_id,
				eval_name: againstPreviousSummary.eval_name,
				summary_path: againstPreviousOutputPath,
				previous_eval_found: againstPreviousSummary.previous_eval_found,
				comparison_count: againstPreviousSummary.comparison_count,
				successful_comparisons: againstPreviousSummary.successful_comparisons,
				failed_comparisons: againstPreviousSummary.failed_comparisons,
				current_wins: againstPreviousSummary.current_wins,
				previous_wins: againstPreviousSummary.previous_wins,
				ties: againstPreviousSummary.ties,
				current_win_rate: againstPreviousSummary.current_win_rate,
				previous_win_rate: againstPreviousSummary.previous_win_rate,
				overall_winner: againstPreviousSummary.overall_winner,
				matched_configurations: againstPreviousSummary.matched_configurations,
				missing_configurations_in_previous: againstPreviousSummary.missing_configurations_in_previous,
				by_configuration: againstPreviousSummary.by_configuration,
			});
		}
	}

	const allConfigurationNames = [...new Set(evalSummaries.flatMap((item) => item.by_configuration.map((entry) => entry.configuration)))].sort();
	const combinedStats = allConfigurationNames.map((configuration) => {
		const entries = evalSummaries
			.flatMap((summary) => summary.by_configuration)
			.filter((entry) => entry.configuration === configuration);
		const wins = entries.reduce((sum, entry) => sum + entry.wins, 0);
		const losses = entries.reduce((sum, entry) => sum + entry.losses, 0);
		const ties = entries.reduce((sum, entry) => sum + entry.ties, 0);
		const comparisons = entries.reduce((sum, entry) => sum + entry.comparisons, 0);
		return {
			configuration,
			wins,
			losses,
			ties,
			comparisons,
			win_rate: comparisons > 0 ? Number((wins / comparisons).toFixed(3)) : null,
			average_eval_win_rate: average(entries.map((entry) => entry.win_rate)),
		};
	}).sort((left, right) => {
		if (right.wins !== left.wins) return right.wins - left.wins;
		const leftRate = left.win_rate ?? -1;
		const rightRate = right.win_rate ?? -1;
		if (rightRate !== leftRate) return rightRate - leftRate;
		return left.configuration.localeCompare(right.configuration);
	});

	const outputSummaryPath = path.resolve(String(options.outputSummary ?? path.join(iterationPath, "blind-comparison-summary.json")));
	const summary = {
		generated_at: new Date().toISOString(),
		iteration_path: iterationPath,
		model: modelId,
		thinking: options.thinking ?? null,
		eval_count: evalSummaries.length,
		comparison_count: evalSummaries.reduce((sum, entry) => sum + entry.comparison_count, 0),
		successful_comparisons: evalSummaries.reduce((sum, entry) => sum + entry.successful_comparisons, 0),
		failed_comparisons: evalSummaries.reduce((sum, entry) => sum + entry.failed_comparisons, 0),
		overall_winner: chooseOverallWinner(combinedStats),
		by_configuration: combinedStats,
		evals: evalSummaries,
	};

	await writeJson(outputSummaryPath, summary);

	let outputVsPreviousSummaryPath;
	let againstPreviousSummary;
	if (previousIterationPath) {
		const previousConfigurationNames = [
			...new Set(againstPreviousEvalSummaries.flatMap((item) => item.by_configuration.map((entry) => entry.configuration))),
		].sort();
		const combinedAgainstPreviousStats = previousConfigurationNames
			.map((configuration) => {
				const entries = againstPreviousEvalSummaries
					.flatMap((entry) => entry.by_configuration)
					.filter((entry) => entry.configuration === configuration);
				const currentWins = entries.reduce((sum, entry) => sum + entry.current_wins, 0);
				const previousWins = entries.reduce((sum, entry) => sum + entry.previous_wins, 0);
				const ties = entries.reduce((sum, entry) => sum + entry.ties, 0);
				const comparisons = entries.reduce((sum, entry) => sum + entry.comparisons, 0);
				return {
					configuration,
					current_wins: currentWins,
					previous_wins: previousWins,
					ties,
					comparisons,
					current_win_rate: comparisons > 0 ? Number((currentWins / comparisons).toFixed(3)) : null,
					previous_win_rate: comparisons > 0 ? Number((previousWins / comparisons).toFixed(3)) : null,
					average_eval_current_win_rate: average(entries.map((entry) => entry.current_win_rate)),
					average_eval_previous_win_rate: average(entries.map((entry) => entry.previous_win_rate)),
					winner: chooseHeadToHeadWinner(currentWins, previousWins),
				};
			})
			.sort((left, right) => {
				if (right.current_wins !== left.current_wins) return right.current_wins - left.current_wins;
				const leftRate = left.current_win_rate ?? -1;
				const rightRate = right.current_win_rate ?? -1;
				if (rightRate !== leftRate) return rightRate - leftRate;
				return left.configuration.localeCompare(right.configuration);
			});

		const againstPreviousOverall = buildAgainstPreviousOverall(combinedAgainstPreviousStats);
		outputVsPreviousSummaryPath = path.resolve(
			String(options.outputVsPreviousSummary ?? path.join(iterationPath, "blind-comparison-vs-previous-summary.json")),
		);
		againstPreviousSummary = {
			generated_at: new Date().toISOString(),
			scope: "vs-previous-iteration",
			iteration_path: iterationPath,
			previous_iteration_path: previousIterationPath,
			model: modelId,
			thinking: options.thinking ?? null,
			eval_count: againstPreviousEvalSummaries.length,
			comparison_count: againstPreviousEvalSummaries.reduce((sum, entry) => sum + entry.comparison_count, 0),
			successful_comparisons: againstPreviousEvalSummaries.reduce((sum, entry) => sum + entry.successful_comparisons, 0),
			failed_comparisons: againstPreviousEvalSummaries.reduce((sum, entry) => sum + entry.failed_comparisons, 0),
			current_wins: againstPreviousOverall.current_wins,
			previous_wins: againstPreviousOverall.previous_wins,
			ties: againstPreviousOverall.ties,
			current_win_rate: againstPreviousOverall.current_win_rate,
			previous_win_rate: againstPreviousOverall.previous_win_rate,
			overall_winner: againstPreviousOverall.winner,
			by_configuration: combinedAgainstPreviousStats,
			evals: againstPreviousEvalSummaries,
		};
		await writeJson(outputVsPreviousSummaryPath, againstPreviousSummary);
	}

	console.log(`Blind comparison written:`);
	console.log(`- summary: ${outputSummaryPath}`);
	if (outputVsPreviousSummaryPath) {
		console.log(`- vs previous summary: ${outputVsPreviousSummaryPath}`);
	}
	console.log(`- evals: ${evalSummaries.length}`);
	console.log(`- comparisons: ${summary.comparison_count}`);
	console.log(`- successful: ${summary.successful_comparisons}`);
	console.log(`- failed: ${summary.failed_comparisons}`);
	if (againstPreviousSummary) {
		console.log(`- vs previous comparisons: ${againstPreviousSummary.comparison_count}`);
		console.log(`- vs previous successful: ${againstPreviousSummary.successful_comparisons}`);
		console.log(`- vs previous failed: ${againstPreviousSummary.failed_comparisons}`);
	}
}

main().catch((error) => {
	console.error(`[compare-iteration] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
