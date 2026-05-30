#!/usr/bin/env -S node --experimental-strip-types

const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

function printUsage() {
	console.log(`Usage:
  aggregate-benchmark.ts --iteration-path <dir> [options]

Options:
  --iteration-path <dir>   Iteration directory to aggregate (required)
  --skill-name <name>      Optional skill name override
  --output-json <file>     Output path for benchmark.json (default: <iteration-path>/benchmark.json)
  --output-md <file>       Output path for benchmark.md (default: <iteration-path>/benchmark.md)
  --help                   Show this help
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

async function findRunDirs(configurationDir) {
	const directRunJson = path.join(configurationDir, "run.json");
	if (existsSync(directRunJson)) {
		return [configurationDir];
	}

	const children = await listSubdirectories(configurationDir);
	return children.filter((child) => existsSync(path.join(child, "run.json")));
}

async function discoverRuns(iterationPath) {
	const evalDirs = (await listSubdirectories(iterationPath)).filter((dir) => path.basename(dir).startsWith("eval-"));
	const runs = [];

	for (const evalDir of evalDirs) {
		const evalMetadataPath = path.join(evalDir, "eval_metadata.json");
		const evalMetadata = existsSync(evalMetadataPath) ? await readJson(evalMetadataPath) : {};
		const configurationDirs = await listSubdirectories(evalDir);

		for (const configurationDir of configurationDirs) {
			const configurationName = path.basename(configurationDir);
			const runDirs = await findRunDirs(configurationDir);
			if (runDirs.length === 0) {
				continue;
			}

			for (const runDir of runDirs) {
				const run = await readJson(path.join(runDir, "run.json"));
				const metricsPath = path.join(runDir, "metrics.json");
				const timingPath = path.join(runDir, "timing.json");
				const gradingPath = path.join(runDir, "grading.json");
				const metrics = existsSync(metricsPath) ? await readJson(metricsPath) : {};
				const timing = existsSync(timingPath) ? await readJson(timingPath) : {};
				const grading = existsSync(gradingPath) ? await readJson(gradingPath) : {};
				const transcriptPath = path.join(runDir, "transcript.md");
				const assistantOutputPath = path.join(runDir, "outputs", "assistant-final.md");

				runs.push({
					eval_id: evalMetadata.evalId ?? null,
					eval_name: evalMetadata.evalName ?? path.basename(evalDir),
					configuration: run.configuration ?? configurationName,
					run_number: run.runNumber ?? 1,
					run_dir: runDir,
					success: Boolean(run.success),
					error_message: run.errorMessage ?? null,
					duration_seconds:
						typeof timing.totalDurationSeconds === "number"
							? timing.totalDurationSeconds
							: typeof timing.durationMs === "number"
								? Number((timing.durationMs / 1000).toFixed(3))
								: null,
						message_count: typeof metrics.messageCount === "number" ? metrics.messageCount : null,
						final_assistant_chars:
							typeof metrics.finalAssistantChars === "number"
								? metrics.finalAssistantChars
								: typeof run.finalAssistantChars === "number"
									? run.finalAssistantChars
									: null,
						tool_execution_starts: typeof metrics.toolExecutionStarts === "number" ? metrics.toolExecutionStarts : null,
						tool_execution_ends: typeof metrics.toolExecutionEnds === "number" ? metrics.toolExecutionEnds : null,
						tool_errors: typeof metrics.toolErrors === "number" ? metrics.toolErrors : null,
						grading_path: existsSync(gradingPath) ? gradingPath : null,
						grading_passed: typeof grading.summary?.passed === "number" ? grading.summary.passed : null,
						grading_failed: typeof grading.summary?.failed === "number" ? grading.summary.failed : null,
						grading_total: typeof grading.summary?.total === "number" ? grading.summary.total : null,
						grading_pass_rate: typeof grading.summary?.pass_rate === "number" ? grading.summary.pass_rate : null,
						transcript_path: existsSync(transcriptPath) ? transcriptPath : null,
						assistant_output_path: existsSync(assistantOutputPath) ? assistantOutputPath : null,
						output_files: Array.isArray(metrics.outputFiles) ? metrics.outputFiles : [],
					});
			}
		}
	}

	return runs;
}

function average(numbers) {
	const valid = numbers.filter((value) => typeof value === "number" && Number.isFinite(value));
	if (valid.length === 0) return null;
	return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(3));
}

function sum(numbers) {
	return numbers
		.filter((value) => typeof value === "number" && Number.isFinite(value))
		.reduce((total, value) => total + value, 0);
}

function buildConfigurationSummary(runs, configuration, blindComparisonSummary) {
	const matching = runs.filter((run) => run.configuration === configuration);
	const blindStats = Array.isArray(blindComparisonSummary?.by_configuration)
		? blindComparisonSummary.by_configuration.find((entry) => entry.configuration === configuration)
		: undefined;
	return {
		configuration,
		run_count: matching.length,
		successful_runs: matching.filter((run) => run.success).length,
		failed_runs: matching.filter((run) => !run.success).length,
		average_duration_seconds: average(matching.map((run) => run.duration_seconds)),
		average_final_assistant_chars: average(matching.map((run) => run.final_assistant_chars)),
		average_message_count: average(matching.map((run) => run.message_count)),
		average_grading_pass_rate: average(matching.map((run) => run.grading_pass_rate)),
		total_grading_passed: sum(matching.map((run) => run.grading_passed)),
		total_grading_failed: sum(matching.map((run) => run.grading_failed)),
		total_tool_execution_starts: sum(matching.map((run) => run.tool_execution_starts)),
		total_tool_errors: sum(matching.map((run) => run.tool_errors)),
		blind_comparison_wins: typeof blindStats?.wins === "number" ? blindStats.wins : 0,
		blind_comparison_losses: typeof blindStats?.losses === "number" ? blindStats.losses : 0,
		blind_comparison_ties: typeof blindStats?.ties === "number" ? blindStats.ties : 0,
		blind_comparison_count: typeof blindStats?.comparisons === "number" ? blindStats.comparisons : 0,
		blind_comparison_win_rate: typeof blindStats?.win_rate === "number" ? blindStats.win_rate : null,
	};
}

function buildEvalSummary(runs, evalId, evalName, blindEvalSummary) {
	const matching = runs.filter((run) => run.eval_id === evalId && run.eval_name === evalName);
	return {
		eval_id: evalId,
		eval_name: evalName,
		run_count: matching.length,
		successful_runs: matching.filter((run) => run.success).length,
		failed_runs: matching.filter((run) => !run.success).length,
		configurations: [...new Set(matching.map((run) => run.configuration))],
		average_duration_seconds: average(matching.map((run) => run.duration_seconds)),
		average_grading_pass_rate: average(matching.map((run) => run.grading_pass_rate)),
		blind_comparison_count: typeof blindEvalSummary?.comparison_count === "number" ? blindEvalSummary.comparison_count : 0,
		blind_successful_comparisons: typeof blindEvalSummary?.successful_comparisons === "number" ? blindEvalSummary.successful_comparisons : 0,
		blind_failed_comparisons: typeof blindEvalSummary?.failed_comparisons === "number" ? blindEvalSummary.failed_comparisons : 0,
		blind_overall_winner: blindEvalSummary?.overall_winner ?? null,
	};
}

function buildBenchmark(
	iterationPath,
	skillName,
	runs,
	blindComparisonSummary,
	blindComparisonSummaryPath,
	blindComparisonVsPreviousSummary,
	blindComparisonVsPreviousSummaryPath,
) {
	const configurations = [...new Set(runs.map((run) => run.configuration))].sort();
	const evalKeys = [...new Map(runs.map((run) => [`${run.eval_id}::${run.eval_name}`, { evalId: run.eval_id, evalName: run.eval_name }])).values()];
	const successfulRuns = runs.filter((run) => run.success).length;
	const failedRuns = runs.filter((run) => !run.success).length;

	const blindEvalLookup = new Map(
		Array.isArray(blindComparisonSummary?.evals)
			? blindComparisonSummary.evals.map((entry) => [`${entry.eval_id}::${entry.eval_name}`, entry])
			: [],
	);

	return {
		metadata: {
			skill_name: skillName,
			iteration_path: iterationPath,
			generated_at: new Date().toISOString(),
			evals_detected: evalKeys.length,
			configurations,
			run_count: runs.length,
			blind_comparison_summary_path: blindComparisonSummaryPath ?? null,
			blind_comparison_vs_previous_summary_path: blindComparisonVsPreviousSummaryPath ?? null,
		},
		runs,
		summaries: {
			overall: {
				run_count: runs.length,
				successful_runs: successfulRuns,
				failed_runs: failedRuns,
				success_rate: runs.length > 0 ? Number((successfulRuns / runs.length).toFixed(3)) : null,
				average_duration_seconds: average(runs.map((run) => run.duration_seconds)),
				average_final_assistant_chars: average(runs.map((run) => run.final_assistant_chars)),
				average_grading_pass_rate: average(runs.map((run) => run.grading_pass_rate)),
				total_grading_passed: sum(runs.map((run) => run.grading_passed)),
				total_grading_failed: sum(runs.map((run) => run.grading_failed)),
				total_tool_execution_starts: sum(runs.map((run) => run.tool_execution_starts)),
				total_tool_errors: sum(runs.map((run) => run.tool_errors)),
				blind_comparison_count: typeof blindComparisonSummary?.comparison_count === "number" ? blindComparisonSummary.comparison_count : 0,
				successful_blind_comparisons:
					typeof blindComparisonSummary?.successful_comparisons === "number" ? blindComparisonSummary.successful_comparisons : 0,
				failed_blind_comparisons:
					typeof blindComparisonSummary?.failed_comparisons === "number" ? blindComparisonSummary.failed_comparisons : 0,
				blind_overall_winner: blindComparisonSummary?.overall_winner ?? null,
				vs_previous: blindComparisonVsPreviousSummary
					? {
						comparison_count:
							typeof blindComparisonVsPreviousSummary.comparison_count === "number"
								? blindComparisonVsPreviousSummary.comparison_count
								: 0,
						successful_comparisons:
							typeof blindComparisonVsPreviousSummary.successful_comparisons === "number"
								? blindComparisonVsPreviousSummary.successful_comparisons
								: 0,
						failed_comparisons:
							typeof blindComparisonVsPreviousSummary.failed_comparisons === "number"
								? blindComparisonVsPreviousSummary.failed_comparisons
								: 0,
						current_wins:
							typeof blindComparisonVsPreviousSummary.current_wins === "number"
								? blindComparisonVsPreviousSummary.current_wins
								: 0,
						previous_wins:
							typeof blindComparisonVsPreviousSummary.previous_wins === "number"
								? blindComparisonVsPreviousSummary.previous_wins
								: 0,
						ties: typeof blindComparisonVsPreviousSummary.ties === "number" ? blindComparisonVsPreviousSummary.ties : 0,
						current_win_rate:
							typeof blindComparisonVsPreviousSummary.current_win_rate === "number"
								? blindComparisonVsPreviousSummary.current_win_rate
								: null,
						previous_win_rate:
							typeof blindComparisonVsPreviousSummary.previous_win_rate === "number"
								? blindComparisonVsPreviousSummary.previous_win_rate
								: null,
						overall_winner: blindComparisonVsPreviousSummary.overall_winner ?? null,
						previous_iteration_path: blindComparisonVsPreviousSummary.previous_iteration_path ?? null,
					}
					: null,
			},
			by_configuration: configurations.map((configuration) => buildConfigurationSummary(runs, configuration, blindComparisonSummary)),
			by_configuration_vs_previous: Array.isArray(blindComparisonVsPreviousSummary?.by_configuration)
				? blindComparisonVsPreviousSummary.by_configuration
				: [],
			by_eval: evalKeys.map(({ evalId, evalName }) => buildEvalSummary(runs, evalId, evalName, blindEvalLookup.get(`${evalId}::${evalName}`))),
		},
	};
}

function renderBenchmarkMarkdown(benchmark) {
	const lines = [
		"# Benchmark Summary",
		"",
		`- skill: ${benchmark.metadata.skill_name}`,
		`- iteration path: ${benchmark.metadata.iteration_path}`,
		`- generated at: ${benchmark.metadata.generated_at}`,
		`- evals detected: ${benchmark.metadata.evals_detected}`,
		`- runs: ${benchmark.metadata.run_count}`,
		"",
		"## Overall",
		"",
		`- successful runs: ${benchmark.summaries.overall.successful_runs}`,
		`- failed runs: ${benchmark.summaries.overall.failed_runs}`,
		`- success rate: ${benchmark.summaries.overall.success_rate ?? "n/a"}`,
		`- average duration seconds: ${benchmark.summaries.overall.average_duration_seconds ?? "n/a"}`,
		`- average final assistant chars: ${benchmark.summaries.overall.average_final_assistant_chars ?? "n/a"}`,
		`- average grading pass rate: ${benchmark.summaries.overall.average_grading_pass_rate ?? "n/a"}`,
		`- total grading passed: ${benchmark.summaries.overall.total_grading_passed}`,
		`- total grading failed: ${benchmark.summaries.overall.total_grading_failed}`,
		`- total tool executions: ${benchmark.summaries.overall.total_tool_execution_starts}`,
		`- total tool errors: ${benchmark.summaries.overall.total_tool_errors}`,
		`- blind comparisons: ${benchmark.summaries.overall.blind_comparison_count ?? 0}`,
		`- successful blind comparisons: ${benchmark.summaries.overall.successful_blind_comparisons ?? 0}`,
		`- failed blind comparisons: ${benchmark.summaries.overall.failed_blind_comparisons ?? 0}`,
		`- blind comparison winner: ${benchmark.summaries.overall.blind_overall_winner ?? "n/a"}`,
		"",
		"## By Configuration",
		"",
	];

	for (const summary of benchmark.summaries.by_configuration) {
		lines.push(`### ${summary.configuration}`);
		lines.push(`- runs: ${summary.run_count}`);
		lines.push(`- successful: ${summary.successful_runs}`);
		lines.push(`- failed: ${summary.failed_runs}`);
		lines.push(`- avg duration seconds: ${summary.average_duration_seconds ?? "n/a"}`);
		lines.push(`- avg final assistant chars: ${summary.average_final_assistant_chars ?? "n/a"}`);
		lines.push(`- avg message count: ${summary.average_message_count ?? "n/a"}`);
		lines.push(`- avg grading pass rate: ${summary.average_grading_pass_rate ?? "n/a"}`);
		lines.push(`- total grading passed: ${summary.total_grading_passed}`);
		lines.push(`- total grading failed: ${summary.total_grading_failed}`);
		lines.push(`- total tool executions: ${summary.total_tool_execution_starts}`);
		lines.push(`- total tool errors: ${summary.total_tool_errors}`);
		lines.push(`- blind comparison wins: ${summary.blind_comparison_wins}`);
		lines.push(`- blind comparison losses: ${summary.blind_comparison_losses}`);
		lines.push(`- blind comparison ties: ${summary.blind_comparison_ties}`);
		lines.push(`- blind comparison win rate: ${summary.blind_comparison_win_rate ?? "n/a"}`);
		lines.push("");
	}

	lines.push("## By Eval", "");
	for (const summary of benchmark.summaries.by_eval) {
		lines.push(`### ${summary.eval_name} (${summary.eval_id ?? "n/a"})`);
		lines.push(`- runs: ${summary.run_count}`);
		lines.push(`- successful: ${summary.successful_runs}`);
		lines.push(`- failed: ${summary.failed_runs}`);
		lines.push(`- configurations: ${summary.configurations.join(", ") || "none"}`);
		lines.push(`- avg duration seconds: ${summary.average_duration_seconds ?? "n/a"}`);
		lines.push(`- avg grading pass rate: ${summary.average_grading_pass_rate ?? "n/a"}`);
		lines.push(`- blind comparisons: ${summary.blind_comparison_count ?? 0}`);
		lines.push(`- successful blind comparisons: ${summary.blind_successful_comparisons ?? 0}`);
		lines.push(`- failed blind comparisons: ${summary.blind_failed_comparisons ?? 0}`);
		lines.push(`- blind overall winner: ${summary.blind_overall_winner ?? "n/a"}`);
		lines.push("");
	}

	if (benchmark.summaries.overall.vs_previous) {
		const vp = benchmark.summaries.overall.vs_previous;
		lines.push("## Versus Previous Iteration", "");
		lines.push(`- previous iteration path: ${vp.previous_iteration_path ?? "n/a"}`);
		lines.push(`- comparisons: ${vp.comparison_count ?? 0}`);
		lines.push(`- successful: ${vp.successful_comparisons ?? 0}`);
		lines.push(`- failed: ${vp.failed_comparisons ?? 0}`);
		lines.push(`- current wins: ${vp.current_wins ?? 0}`);
		lines.push(`- previous wins: ${vp.previous_wins ?? 0}`);
		lines.push(`- ties: ${vp.ties ?? 0}`);
		lines.push(`- current win rate: ${vp.current_win_rate ?? "n/a"}`);
		lines.push(`- previous win rate: ${vp.previous_win_rate ?? "n/a"}`);
		lines.push(`- overall winner: ${vp.overall_winner ?? "n/a"}`);
		lines.push("");
		if (
			Array.isArray(benchmark.summaries.by_configuration_vs_previous) &&
			benchmark.summaries.by_configuration_vs_previous.length > 0
		) {
			lines.push("### By Configuration vs Previous", "");
			for (const entry of benchmark.summaries.by_configuration_vs_previous) {
				lines.push(`#### ${entry.configuration}`);
				lines.push(`- current wins: ${entry.current_wins ?? 0}`);
				lines.push(`- previous wins: ${entry.previous_wins ?? 0}`);
				lines.push(`- ties: ${entry.ties ?? 0}`);
				lines.push(`- comparisons: ${entry.comparisons ?? 0}`);
				lines.push(`- current win rate: ${entry.current_win_rate ?? "n/a"}`);
				lines.push(`- previous win rate: ${entry.previous_win_rate ?? "n/a"}`);
				lines.push(`- winner: ${entry.winner ?? "n/a"}`);
				lines.push("");
			}
		}
	}

	return `${lines.join("\n")}\n`;
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

	const iterationJsonPath = path.join(iterationPath, "iteration.json");
	const iterationJson = existsSync(iterationJsonPath) ? await readJson(iterationJsonPath) : {};
	const skillName =
		String(options.skillName ?? "").trim() ||
		(typeof iterationJson.skillPath === "string" && iterationJson.skillPath
			? path.basename(iterationJson.skillPath)
			: path.basename(path.dirname(iterationPath)));
	const runs = await discoverRuns(iterationPath);
	const blindComparisonSummaryPath = existsSync(path.join(iterationPath, "blind-comparison-summary.json"))
		? path.join(iterationPath, "blind-comparison-summary.json")
		: undefined;
	const blindComparisonSummary = blindComparisonSummaryPath ? await readJson(blindComparisonSummaryPath) : undefined;
	const blindComparisonVsPreviousSummaryPath = existsSync(path.join(iterationPath, "blind-comparison-vs-previous-summary.json"))
		? path.join(iterationPath, "blind-comparison-vs-previous-summary.json")
		: undefined;
	const blindComparisonVsPreviousSummary = blindComparisonVsPreviousSummaryPath
		? await readJson(blindComparisonVsPreviousSummaryPath)
		: undefined;
	const benchmark = buildBenchmark(
		iterationPath,
		skillName || "unknown-skill",
		runs,
		blindComparisonSummary,
		blindComparisonSummaryPath,
		blindComparisonVsPreviousSummary,
		blindComparisonVsPreviousSummaryPath,
	);
	const outputJsonPath = path.resolve(String(options.outputJson ?? path.join(iterationPath, "benchmark.json")));
	const outputMdPath = path.resolve(String(options.outputMd ?? path.join(iterationPath, "benchmark.md")));

	await writeJson(outputJsonPath, benchmark);
	await writeText(outputMdPath, renderBenchmarkMarkdown(benchmark));

	console.log(`Benchmark written:`);
	console.log(`- json: ${outputJsonPath}`);
	console.log(`- md: ${outputMdPath}`);
	console.log(`Runs: ${benchmark.summaries.overall.run_count}`);
	console.log(`Successful: ${benchmark.summaries.overall.successful_runs}`);
	console.log(`Failed: ${benchmark.summaries.overall.failed_runs}`);
	console.log(`Blind comparisons: ${benchmark.summaries.overall.blind_comparison_count ?? 0}`);
	if (benchmark.summaries.overall.vs_previous) {
		const vp = benchmark.summaries.overall.vs_previous;
		console.log(
			`Vs previous: ${vp.comparison_count ?? 0} comparisons, ${vp.current_wins ?? 0}-${vp.previous_wins ?? 0}-${vp.ties ?? 0} (W-L-T), winner: ${vp.overall_winner ?? "n/a"}`,
		);
	}
}

main().catch((error) => {
	console.error(`[aggregate-benchmark] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
