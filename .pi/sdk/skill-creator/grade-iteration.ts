#!/usr/bin/env -S node --experimental-strip-types

const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

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

const STOP_WORDS = new Set([
	"the",
	"and",
	"that",
	"with",
	"from",
	"this",
	"have",
	"into",
	"your",
	"should",
	"would",
	"could",
	"must",
	"there",
	"their",
	"about",
	"after",
	"before",
	"when",
	"where",
	"which",
	"while",
	"then",
	"than",
	"includes",
	"include",
	"including",
	"contains",
	"contain",
	"mentions",
	"mention",
	"shows",
	"show",
	"says",
	"say",
	"output",
	"response",
	"assistant",
	"result",
	"final",
	"expected",
	"uses",
	"used",
	"using",
]);

function printUsage() {
	console.log(`Usage:
  grade-iteration.ts --iteration-path <dir> [options]

Options:
  --iteration-path <dir>    Iteration directory to grade (required)
  --eval-set <file>         Optional evals.json path for expectation lookup fallback
  --output-summary <file>   Output path for grading-summary.json (default: <iteration-path>/grading-summary.json)
  --help                    Show this help
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
	return String(value ?? "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function tokenize(value) {
	return normalizeText(value)
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

function unique(values) {
	return [...new Set(values)];
}

function extractQuotedPhrases(text) {
	const phrases = [];
	for (const pattern of [/'([^']{2,})'/g, /"([^"]{2,})"/g, /`([^`]{2,})`/g]) {
		for (const match of text.matchAll(pattern)) {
			phrases.push(match[1]);
		}
	}
	return unique(phrases.map((phrase) => phrase.trim()).filter(Boolean));
}

function buildSearchCorpus(documents) {
	return documents
		.map((document) => ({
			path: document.path,
			text: document.text,
			normalized: normalizeText(document.text),
			tokens: new Set(tokenize(document.text)),
		}))
		.filter((document) => document.normalized.length > 0);
}

function findPhraseEvidence(corpus, phrase) {
	const normalizedPhrase = normalizeText(phrase);
	if (!normalizedPhrase) return undefined;
	for (const document of corpus) {
		const index = document.normalized.indexOf(normalizedPhrase);
		if (index !== -1) {
			const excerpt = document.text.slice(Math.max(0, index - 120), Math.min(document.text.length, index + phrase.length + 120)).trim();
			return `Matched phrase ${JSON.stringify(phrase)} in ${document.path}${excerpt ? `: ${excerpt}` : ""}`;
		}
	}
	return undefined;
}

function findTokenEvidence(corpus, expectation) {
	const tokens = unique(tokenize(expectation));
	if (tokens.length === 0) return undefined;

	for (const document of corpus) {
		const matched = tokens.filter((token) => document.tokens.has(token));
		if (matched.length === tokens.length && tokens.length > 0) {
			return `Matched all significant expectation tokens in ${document.path}: ${matched.join(", ")}`;
		}
	}

	return undefined;
}

function evaluateExpectation(expectation, corpus) {
	const quotedPhrases = extractQuotedPhrases(expectation);
	for (const phrase of quotedPhrases) {
		const evidence = findPhraseEvidence(corpus, phrase);
		if (evidence) {
			return { text: expectation, passed: true, evidence };
		}
	}

	const exactEvidence = findPhraseEvidence(corpus, expectation);
	if (exactEvidence) {
		return { text: expectation, passed: true, evidence: exactEvidence };
	}

	const tokenEvidence = findTokenEvidence(corpus, expectation);
	if (tokenEvidence) {
		return { text: expectation, passed: true, evidence: tokenEvidence };
	}

	return {
		text: expectation,
		passed: false,
		evidence: "No clear supporting evidence was found in transcript.md or text outputs.",
	};
}

function summarizeExpectations(expectationResults) {
	const passed = expectationResults.filter((item) => item.passed).length;
	const failed = expectationResults.length - passed;
	return {
		passed,
		failed,
		total: expectationResults.length,
		pass_rate: expectationResults.length > 0 ? Number((passed / expectationResults.length).toFixed(3)) : null,
	};
}

function buildEvalFeedback(expectations) {
	const suggestions = [];
	for (const expectation of expectations) {
		const tokens = tokenize(expectation);
		const quotedPhrases = extractQuotedPhrases(expectation);
		if (quotedPhrases.length > 0 && tokens.length <= quotedPhrases.join(" ").split(/\s+/).length + 1) {
			suggestions.push({
				assertion: expectation,
				reason: "This expectation looks close to a phrase-presence check. Consider adding a stronger correctness or content-quality requirement.",
			});
			continue;
		}
		if (tokens.length < 3) {
			suggestions.push({
				assertion: expectation,
				reason: "This expectation may be too short or generic to discriminate between a strong output and a weak one.",
			});
		}
	}

	return {
		suggestions,
		overall: suggestions.length > 0 ? "Some expectations may be easy to satisfy superficially." : "No suggestions, eval expectations look reasonable for this heuristic grader.",
	};
}

function buildClaims(runJson, outputFiles) {
	const claims = [];
	if (runJson.success === true) {
		claims.push({
			claim: "The run completed successfully.",
			type: "process",
			verified: true,
			evidence: "run.json recorded success: true",
		});
	}
	if (outputFiles.length > 0) {
		claims.push({
			claim: `The run produced ${outputFiles.length} output file(s).`,
			type: "process",
			verified: true,
			evidence: `Detected output files under outputs/: ${outputFiles.map((filePath) => path.basename(filePath)).join(", ")}`,
		});
	}
	return claims;
}

async function readUserNotesSummary(runDir) {
	const notesPath = path.join(runDir, "outputs", "user_notes.md");
	if (!existsSync(notesPath)) {
		return {
			uncertainties: [],
			needs_review: [],
			workarounds: [],
		};
	}

	const text = await readText(notesPath);
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	const summary = {
		uncertainties: [],
		needs_review: [],
		workarounds: [],
	};

	let currentKey;
	for (const line of lines) {
		const heading = line.toLowerCase();
		if (heading.includes("uncertaint")) currentKey = "uncertainties";
		else if (heading.includes("needs review") || heading.includes("review")) currentKey = "needs_review";
		else if (heading.includes("workaround")) currentKey = "workarounds";
		else if (line.startsWith("- ") && currentKey) summary[currentKey].push(line.slice(2).trim());
	}
	return summary;
}

async function collectDocuments(runDir) {
	const transcriptPath = path.join(runDir, "transcript.md");
	const documents = [];

	if (existsSync(transcriptPath)) {
		documents.push({ path: "transcript.md", text: await readText(transcriptPath) });
	}

	const outputsDir = path.join(runDir, "outputs");
	const outputFiles = await listFilesRecursive(outputsDir);
	for (const filePath of outputFiles) {
		if (!TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
		try {
			documents.push({
				path: path.relative(runDir, filePath),
				text: await readText(filePath),
			});
		} catch {
			// ignore unreadable output files
		}
	}

	return { documents, outputFiles };
}

async function gradeRun(runDir, evalMetadata, fallbackExpectations) {
	const runJsonPath = path.join(runDir, "run.json");
	const metricsPath = path.join(runDir, "metrics.json");
	const timingPath = path.join(runDir, "timing.json");
	const runJson = existsSync(runJsonPath) ? await readJson(runJsonPath) : {};
	const metrics = existsSync(metricsPath) ? await readJson(metricsPath) : {};
	const timing = existsSync(timingPath) ? await readJson(timingPath) : {};
	const { documents, outputFiles } = await collectDocuments(runDir);
	const corpus = buildSearchCorpus(documents);
	const expectations = Array.isArray(evalMetadata.expectations) && evalMetadata.expectations.length > 0
		? evalMetadata.expectations
		: fallbackExpectations;
	const expectationResults = expectations.map((expectation) => evaluateExpectation(expectation, corpus));
	const summary = summarizeExpectations(expectationResults);
	const grading = {
		generated_at: new Date().toISOString(),
		eval_id: evalMetadata.evalId ?? null,
		eval_name: evalMetadata.evalName ?? null,
		prompt: evalMetadata.prompt ?? null,
		expectations: expectationResults,
		summary,
		execution_metrics: {
			tool_execution_starts: typeof metrics.toolExecutionStarts === "number" ? metrics.toolExecutionStarts : null,
			tool_execution_ends: typeof metrics.toolExecutionEnds === "number" ? metrics.toolExecutionEnds : null,
			tool_errors: typeof metrics.toolErrors === "number" ? metrics.toolErrors : null,
			message_count: typeof metrics.messageCount === "number" ? metrics.messageCount : null,
			final_assistant_chars: typeof metrics.finalAssistantChars === "number" ? metrics.finalAssistantChars : null,
			output_files: outputFiles.map((filePath) => path.relative(runDir, filePath)),
		},
		timing: {
			total_duration_seconds:
				typeof timing.totalDurationSeconds === "number"
					? timing.totalDurationSeconds
					: typeof timing.durationMs === "number"
						? Number((timing.durationMs / 1000).toFixed(3))
						: null,
		},
		claims: buildClaims(runJson, outputFiles),
		user_notes_summary: await readUserNotesSummary(runDir),
		eval_feedback: buildEvalFeedback(expectations),
	};
	await writeJson(path.join(runDir, "grading.json"), grading);
	return {
		runDir,
		configuration: runJson.configuration ?? path.basename(path.dirname(runDir)) ?? path.basename(runDir),
		runNumber: runJson.runNumber ?? 1,
		success: Boolean(runJson.success),
		grading,
	};
}

function buildComparison(evalMetadata, gradedRuns) {
	const grouped = new Map();
	for (const gradedRun of gradedRuns) {
		if (!grouped.has(gradedRun.configuration)) {
			grouped.set(gradedRun.configuration, []);
		}
		grouped.get(gradedRun.configuration).push(gradedRun);
	}

	const configurations = [...grouped.entries()].map(([configuration, runs]) => {
		const passRates = runs
			.map((run) => run.grading.summary.pass_rate)
			.filter((value) => typeof value === "number");
		const avgPassRate = passRates.length > 0
			? Number((passRates.reduce((sum, value) => sum + value, 0) / passRates.length).toFixed(3))
			: null;
		const successCount = runs.filter((run) => run.success).length;
		const avgDuration = (() => {
			const durations = runs
				.map((run) => run.grading.timing.total_duration_seconds)
				.filter((value) => typeof value === "number");
			return durations.length > 0
				? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(3))
				: null;
		})();
		return {
			configuration,
			run_count: runs.length,
			successful_runs: successCount,
			average_pass_rate: avgPassRate,
			average_duration_seconds: avgDuration,
		};
	});

	configurations.sort((left, right) => {
		const leftPass = left.average_pass_rate ?? -1;
		const rightPass = right.average_pass_rate ?? -1;
		if (rightPass !== leftPass) return rightPass - leftPass;
		if (right.successful_runs !== left.successful_runs) return right.successful_runs - left.successful_runs;
		const leftDuration = left.average_duration_seconds ?? Number.POSITIVE_INFINITY;
		const rightDuration = right.average_duration_seconds ?? Number.POSITIVE_INFINITY;
		return leftDuration - rightDuration;
	});

	const winner = configurations.length === 0
		? "tie"
		: configurations.length === 1
			? configurations[0].configuration
			: configurations[0].average_pass_rate === configurations[1].average_pass_rate &&
				configurations[0].successful_runs === configurations[1].successful_runs
				? "tie"
				: configurations[0].configuration;

	return {
		generated_at: new Date().toISOString(),
		eval_id: evalMetadata.evalId ?? null,
		eval_name: evalMetadata.evalName ?? null,
		winner,
		reasoning:
			winner === "tie"
				? "Top configurations were indistinguishable with the current heuristic grading signals."
				: `Winner selected by average expectation pass rate, then successful run count, then average duration: ${winner}.`,
		configurations,
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
	const evalDirs = (await listSubdirectories(iterationPath)).filter((dir) => path.basename(dir).startsWith("eval-"));
	const summaryEntries = [];

	for (const evalDir of evalDirs) {
		const evalMetadataPath = path.join(evalDir, "eval_metadata.json");
		const evalMetadata = existsSync(evalMetadataPath) ? await readJson(evalMetadataPath) : {};
		const fallbackEvalEntry =
			lookup.byId.get(String(evalMetadata.evalId ?? "")) ??
			lookup.byName.get(String(evalMetadata.evalName ?? ""));
		const fallbackExpectations = Array.isArray(fallbackEvalEntry?.expectations) ? fallbackEvalEntry.expectations : [];
		const configurationDirs = await listSubdirectories(evalDir);
		const gradedRuns = [];

		for (const configurationDir of configurationDirs) {
			const runDirs = await findRunDirs(configurationDir);
			for (const runDir of runDirs) {
				const gradedRun = await gradeRun(runDir, evalMetadata, fallbackExpectations);
				gradedRuns.push(gradedRun);
				summaryEntries.push({
					eval_id: evalMetadata.evalId ?? null,
					eval_name: evalMetadata.evalName ?? path.basename(evalDir),
					configuration: gradedRun.configuration,
					run_number: gradedRun.runNumber,
					run_dir: runDir,
					grading_path: path.join(runDir, "grading.json"),
					summary: gradedRun.grading.summary,
				});
			}
		}

		const comparison = buildComparison(evalMetadata, gradedRuns);
		await writeJson(path.join(evalDir, "comparison.json"), comparison);
	}

	const outputSummaryPath = path.resolve(String(options.outputSummary ?? path.join(iterationPath, "grading-summary.json")));
	const summary = {
		generated_at: new Date().toISOString(),
		iteration_path: iterationPath,
		graded_runs: summaryEntries.length,
		runs: summaryEntries,
	};
	await writeJson(outputSummaryPath, summary);

	console.log(`Grading written:`);
	console.log(`- summary: ${outputSummaryPath}`);
	console.log(`- run gradings: ${summaryEntries.length}`);
}

main().catch((error) => {
	console.error(`[grade-iteration] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
