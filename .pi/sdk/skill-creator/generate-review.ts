#!/usr/bin/env -S node --experimental-strip-types

const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

function printUsage() {
	console.log(`Usage:
  generate-review.ts --iteration-path <dir> [options]

Options:
  --iteration-path <dir>      Iteration directory to review (required)
  --skill-name <name>         Optional skill name override
  --benchmark <file>          Optional benchmark.json path
  --previous-iteration <dir>  Optional previous iteration path
  --output <file>             Output path for review.html (default: <iteration-path>/review.html)
  --help                      Show this help
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

async function readTextIfExists(filePath) {
	if (!existsSync(filePath)) return "";
	return await fs.readFile(filePath, "utf8");
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
		const absolute = path.join(rootPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFilesRecursive(absolute)));
		} else {
			files.push(absolute);
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

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function relativeHref(fromDir, targetPath) {
	return encodeURI(path.relative(fromDir, targetPath).split(path.sep).join("/"));
}

function formatMaybe(value) {
	return value === null || value === undefined || value === "" ? "n/a" : String(value);
}

function excerpt(text, maxChars = 4000) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return "";
	return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}\n\n[truncated]`;
}

async function discoverEvalEntries(iterationPath) {
	const evalDirs = (await listSubdirectories(iterationPath)).filter((dir) => path.basename(dir).startsWith("eval-"));
	const evalEntries = [];

	for (const evalDir of evalDirs) {
		const evalMetadataPath = path.join(evalDir, "eval_metadata.json");
		const evalMetadata = existsSync(evalMetadataPath) ? await readJson(evalMetadataPath) : {};
		const configurations = [];

		for (const configurationDir of await listSubdirectories(evalDir)) {
			const configurationName = path.basename(configurationDir);
			const runDirs = await findRunDirs(configurationDir);
			if (runDirs.length === 0) continue;

			const runs = [];
			for (const runDir of runDirs) {
				const runJson = await readJson(path.join(runDir, "run.json"));
				const timingPath = path.join(runDir, "timing.json");
				const metricsPath = path.join(runDir, "metrics.json");
				const gradingPath = path.join(runDir, "grading.json");
				const timing = existsSync(timingPath) ? await readJson(timingPath) : {};
				const metrics = existsSync(metricsPath) ? await readJson(metricsPath) : {};
				const grading = existsSync(gradingPath) ? await readJson(gradingPath) : {};
				const outputDir = path.join(runDir, "outputs");
				const outputFiles = await listFilesRecursive(outputDir);
				const assistantOutputPath = path.join(outputDir, "assistant-final.md");
				const assistantOutput = await readTextIfExists(assistantOutputPath);
				const transcriptPath = path.join(runDir, "transcript.md");

				runs.push({
					runNumber: runJson.runNumber ?? 1,
					runDir,
					success: Boolean(runJson.success),
					errorMessage: runJson.errorMessage ?? null,
					durationSeconds:
						typeof timing.totalDurationSeconds === "number"
							? timing.totalDurationSeconds
							: typeof timing.durationMs === "number"
								? Number((timing.durationMs / 1000).toFixed(3))
								: null,
						messageCount: typeof metrics.messageCount === "number" ? metrics.messageCount : null,
						finalAssistantChars: typeof metrics.finalAssistantChars === "number" ? metrics.finalAssistantChars : null,
						toolExecutionStarts: typeof metrics.toolExecutionStarts === "number" ? metrics.toolExecutionStarts : null,
						toolErrors: typeof metrics.toolErrors === "number" ? metrics.toolErrors : null,
						gradingPath: existsSync(gradingPath) ? gradingPath : null,
						gradingSummary: grading.summary ?? null,
						gradingExpectations: Array.isArray(grading.expectations) ? grading.expectations : [],
						assistantOutputPath: existsSync(assistantOutputPath) ? assistantOutputPath : null,
						transcriptPath: existsSync(transcriptPath) ? transcriptPath : null,
						assistantOutputExcerpt: excerpt(assistantOutput),
						outputFiles,
					});
			}

			configurations.push({
				name: configurationName,
				runs,
			});
		}

		const comparisonPath = path.join(evalDir, "comparison.json");
		const comparison = existsSync(comparisonPath) ? await readJson(comparisonPath) : undefined;
		const blindComparisonPath = path.join(evalDir, "blind-comparison.json");
		const blindComparison = existsSync(blindComparisonPath) ? await readJson(blindComparisonPath) : undefined;
		const blindComparisonVsPreviousPath = path.join(evalDir, "blind-comparison-vs-previous.json");
		const blindComparisonVsPrevious = existsSync(blindComparisonVsPreviousPath) ? await readJson(blindComparisonVsPreviousPath) : undefined;

		evalEntries.push({
			evalDir,
			evalId: evalMetadata.evalId ?? null,
			evalName: evalMetadata.evalName ?? path.basename(evalDir),
			prompt: evalMetadata.prompt ?? "",
			expectedOutput: evalMetadata.expectedOutput ?? null,
			expectations: Array.isArray(evalMetadata.expectations) ? evalMetadata.expectations : [],
			files: Array.isArray(evalMetadata.files) ? evalMetadata.files : [],
			comparison,
			blindComparison,
			blindComparisonPath: existsSync(blindComparisonPath) ? blindComparisonPath : null,
			blindComparisonVsPrevious,
			blindComparisonVsPreviousPath: existsSync(blindComparisonVsPreviousPath) ? blindComparisonVsPreviousPath : null,
			configurations,
		});
	}

	return evalEntries;
}

function renderBenchmarkSection(benchmark) {
	if (!benchmark) {
		return `<section><h2>Benchmark</h2><p>No benchmark.json was provided or found.</p></section>`;
	}

	const configRows = (benchmark.summaries?.by_configuration ?? [])
		.map(
			(summary) => `
				<tr>
					<td>${escapeHtml(summary.configuration)}</td>
					<td>${escapeHtml(summary.run_count)}</td>
					<td>${escapeHtml(summary.successful_runs)}</td>
					<td>${escapeHtml(summary.failed_runs)}</td>
					<td>${escapeHtml(summary.average_duration_seconds ?? "n/a")}</td>
					<td>${escapeHtml(summary.average_grading_pass_rate ?? "n/a")}</td>
					<td>${escapeHtml(summary.blind_comparison_win_rate ?? "n/a")}</td>
				</tr>`,
		)
		.join("");

	return `
		<section>
			<h2>Benchmark</h2>
			<ul>
				<li>runs: ${escapeHtml(benchmark.summaries?.overall?.run_count ?? "n/a")}</li>
				<li>successful runs: ${escapeHtml(benchmark.summaries?.overall?.successful_runs ?? "n/a")}</li>
				<li>failed runs: ${escapeHtml(benchmark.summaries?.overall?.failed_runs ?? "n/a")}</li>
				<li>success rate: ${escapeHtml(benchmark.summaries?.overall?.success_rate ?? "n/a")}</li>
				<li>average duration seconds: ${escapeHtml(benchmark.summaries?.overall?.average_duration_seconds ?? "n/a")}</li>
				<li>average grading pass rate: ${escapeHtml(benchmark.summaries?.overall?.average_grading_pass_rate ?? "n/a")}</li>
				<li>blind comparisons: ${escapeHtml(benchmark.summaries?.overall?.blind_comparison_count ?? 0)}</li>
				<li>successful blind comparisons: ${escapeHtml(benchmark.summaries?.overall?.successful_blind_comparisons ?? 0)}</li>
				<li>failed blind comparisons: ${escapeHtml(benchmark.summaries?.overall?.failed_blind_comparisons ?? 0)}</li>
				<li>blind comparison winner: ${escapeHtml(benchmark.summaries?.overall?.blind_overall_winner ?? "n/a")}</li>
			</ul>
			<table>
				<thead>
					<tr><th>Configuration</th><th>Runs</th><th>Successful</th><th>Failed</th><th>Avg duration (s)</th><th>Avg grading pass rate</th><th>Blind win rate</th></tr>
				</thead>
				<tbody>${configRows}</tbody>
			</table>
		</section>`;
}

function renderAgainstPreviousSection(iterationPath, summary) {
	if (!summary) {
		return "";
	}

	const configRows = (summary.by_configuration ?? [])
		.map(
			(entry) => `
				<tr>
					<td>${escapeHtml(entry.configuration)}</td>
					<td>${escapeHtml(entry.comparisons ?? 0)}</td>
					<td>${escapeHtml(entry.current_wins ?? 0)}</td>
					<td>${escapeHtml(entry.previous_wins ?? 0)}</td>
					<td>${escapeHtml(entry.ties ?? 0)}</td>
					<td>${escapeHtml(entry.current_win_rate ?? "n/a")}</td>
					<td>${escapeHtml(entry.previous_win_rate ?? "n/a")}</td>
					<td>${escapeHtml(entry.winner ?? "n/a")}</td>
				</tr>`,
		)
		.join("");

	return `
		<section>
			<h2>Against Previous Iteration</h2>
			<ul>
				<li>previous iteration: <code>${escapeHtml(summary.previous_iteration_path ?? "not provided")}</code></li>
				<li>comparisons: ${escapeHtml(summary.comparison_count ?? 0)}</li>
				<li>successful comparisons: ${escapeHtml(summary.successful_comparisons ?? 0)}</li>
				<li>failed comparisons: ${escapeHtml(summary.failed_comparisons ?? 0)}</li>
				<li>current wins: ${escapeHtml(summary.current_wins ?? 0)}</li>
				<li>previous wins: ${escapeHtml(summary.previous_wins ?? 0)}</li>
				<li>ties: ${escapeHtml(summary.ties ?? 0)}</li>
				<li>overall winner: ${escapeHtml(summary.overall_winner ?? "n/a")}</li>
			</ul>
			${configRows ? `<table><thead><tr><th>Configuration</th><th>Comparisons</th><th>Current wins</th><th>Previous wins</th><th>Ties</th><th>Current win rate</th><th>Previous win rate</th><th>Winner</th></tr></thead><tbody>${configRows}</tbody></table>` : "<p>No cross-iteration comparisons were found.</p>"}
		</section>`;
}

function renderEvalSection(iterationPath, entry) {
	const configurationHtml = entry.configurations
		.map((configuration) => {
			const runsHtml = configuration.runs
				.map((run) => {
					const outputLinks = run.outputFiles
						.map((filePath) => `<li><a href="${relativeHref(iterationPath, filePath)}">${escapeHtml(path.relative(iterationPath, filePath))}</a></li>`)
						.join("");
					const gradingDetails = run.gradingExpectations
						.map(
							(item) => `<li><strong>${item.passed ? "PASS" : "FAIL"}</strong> — ${escapeHtml(item.text)}<br /><span class="muted">${escapeHtml(item.evidence ?? "")}</span></li>`,
						)
						.join("");
					return `
						<article class="run-card ${run.success ? "success" : "failure"}">
							<h4>Run ${escapeHtml(run.runNumber)}</h4>
							<ul>
								<li>status: ${run.success ? "success" : "failure"}</li>
								<li>duration seconds: ${escapeHtml(formatMaybe(run.durationSeconds))}</li>
								<li>message count: ${escapeHtml(formatMaybe(run.messageCount))}</li>
								<li>assistant chars: ${escapeHtml(formatMaybe(run.finalAssistantChars))}</li>
								<li>tool executions: ${escapeHtml(formatMaybe(run.toolExecutionStarts))}</li>
								<li>tool errors: ${escapeHtml(formatMaybe(run.toolErrors))}</li>
								<li>grading pass rate: ${escapeHtml(formatMaybe(run.gradingSummary?.pass_rate))}</li>
								<li>grading passed: ${escapeHtml(formatMaybe(run.gradingSummary?.passed))}</li>
								<li>grading failed: ${escapeHtml(formatMaybe(run.gradingSummary?.failed))}</li>
								<li>grading file: ${run.gradingPath ? `<a href="${relativeHref(iterationPath, run.gradingPath)}">open grading</a>` : "n/a"}</li>
								<li>transcript: ${run.transcriptPath ? `<a href="${relativeHref(iterationPath, run.transcriptPath)}">open transcript</a>` : "n/a"}</li>
								<li>assistant output: ${run.assistantOutputPath ? `<a href="${relativeHref(iterationPath, run.assistantOutputPath)}">open output</a>` : "n/a"}</li>
							</ul>
							${run.errorMessage ? `<p><strong>Error:</strong> ${escapeHtml(run.errorMessage)}</p>` : ""}
							${run.outputFiles.length > 0 ? `<details><summary>Output files</summary><ul>${outputLinks}</ul></details>` : ""}
							${gradingDetails ? `<details><summary>Expectation grading</summary><ul>${gradingDetails}</ul></details>` : ""}
							${run.assistantOutputExcerpt ? `<details open><summary>Assistant output excerpt</summary><pre>${escapeHtml(run.assistantOutputExcerpt)}</pre></details>` : ""}
						</article>`;
				})
				.join("");
			return `
				<section class="configuration-section">
					<h3>${escapeHtml(configuration.name)}</h3>
					${runsHtml || "<p>No runs found.</p>"}
				</section>`;
		})
		.join("");

	return `
		<section class="eval-section">
			<h2>${escapeHtml(entry.evalName)} ${entry.evalId !== null ? `<span class="muted">(#${escapeHtml(entry.evalId)})</span>` : ""}</h2>
			<div class="meta-grid">
				<div>
					<h3>Prompt</h3>
					<pre>${escapeHtml(entry.prompt || "")}</pre>
				</div>
				<div>
					<h3>Expected output</h3>
					<pre>${escapeHtml(entry.expectedOutput || "")}</pre>
				</div>
			</div>
			${entry.expectations.length > 0 ? `<details open><summary>Expectations</summary><ul>${entry.expectations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : ""}
			${entry.comparison ? `<details open><summary>Heuristic comparison summary</summary><pre>${escapeHtml(JSON.stringify(entry.comparison, null, 2))}</pre></details>` : ""}
			${entry.blindComparison ? `<details open><summary>Blind comparison summary</summary><ul><li>overall winner: ${escapeHtml(entry.blindComparison.overall_winner ?? "n/a")}</li><li>comparisons: ${escapeHtml(entry.blindComparison.comparison_count ?? 0)}</li><li>successful: ${escapeHtml(entry.blindComparison.successful_comparisons ?? 0)}</li><li>failed: ${escapeHtml(entry.blindComparison.failed_comparisons ?? 0)}</li><li>summary file: ${entry.blindComparisonPath ? `<a href="${relativeHref(iterationPath, entry.blindComparisonPath)}">open blind summary</a>` : "n/a"}</li></ul><pre>${escapeHtml(JSON.stringify(entry.blindComparison, null, 2))}</pre></details>` : ""}
			${entry.blindComparisonVsPrevious ? `<details open><summary>Blind comparison vs previous iteration</summary><ul><li>overall winner: ${escapeHtml(entry.blindComparisonVsPrevious.overall_winner ?? "n/a")}</li><li>comparisons: ${escapeHtml(entry.blindComparisonVsPrevious.comparison_count ?? 0)}</li><li>successful: ${escapeHtml(entry.blindComparisonVsPrevious.successful_comparisons ?? 0)}</li><li>failed: ${escapeHtml(entry.blindComparisonVsPrevious.failed_comparisons ?? 0)}</li><li>previous eval found: ${escapeHtml(entry.blindComparisonVsPrevious.previous_eval_found ?? false)}</li><li>summary file: ${entry.blindComparisonVsPreviousPath ? `<a href="${relativeHref(iterationPath, entry.blindComparisonVsPreviousPath)}">open previous-iteration summary</a>` : "n/a"}</li></ul><pre>${escapeHtml(JSON.stringify(entry.blindComparisonVsPrevious, null, 2))}</pre></details>` : ""}
			${entry.files.length > 0 ? `<details><summary>Input files</summary><ul>${entry.files.map((filePath) => `<li>${escapeHtml(filePath)}</li>`).join("")}</ul></details>` : ""}
			${configurationHtml || "<p>No configuration runs found.</p>"}
		</section>`;
}

function renderHtml(options) {
	const benchmarkSection = renderBenchmarkSection(options.benchmark);
	const againstPreviousSection = renderAgainstPreviousSection(options.iterationPath, options.blindComparisonVsPreviousSummary);
	const evalSections = options.evalEntries.map((entry) => renderEvalSection(options.iterationPath, entry)).join("\n");

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Skill Review - ${escapeHtml(options.skillName)}</title>
  <style>
    :root { color-scheme: dark light; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
    h1, h2, h3, h4 { margin-top: 0; }
    pre { white-space: pre-wrap; background: rgba(127,127,127,0.12); padding: 1rem; border-radius: 8px; overflow: auto; }
    code { background: rgba(127,127,127,0.12); padding: 0.15rem 0.35rem; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid rgba(127,127,127,0.25); padding: 0.5rem; text-align: left; vertical-align: top; }
    .muted { opacity: 0.7; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
    .eval-section { margin-top: 2rem; padding-top: 1.5rem; border-top: 2px solid rgba(127,127,127,0.2); }
    .configuration-section { margin-top: 1.25rem; }
    .run-card { border: 1px solid rgba(127,127,127,0.25); border-radius: 10px; padding: 1rem; margin: 1rem 0; }
    .run-card.success { border-color: rgba(0, 180, 0, 0.45); }
    .run-card.failure { border-color: rgba(220, 60, 60, 0.55); }
    ul { padding-left: 1.25rem; }
    .header-box { border: 1px solid rgba(127,127,127,0.25); border-radius: 10px; padding: 1rem 1.25rem; }
  </style>
</head>
<body>
  <header class="header-box">
    <h1>Skill Review</h1>
    <ul>
      <li>skill: ${escapeHtml(options.skillName)}</li>
      <li>iteration path: <code>${escapeHtml(options.iterationPath)}</code></li>
      <li>generated at: ${escapeHtml(options.generatedAt)}</li>
      <li>benchmark: ${options.benchmarkPath ? `<code>${escapeHtml(options.benchmarkPath)}</code>` : "not provided"}</li>
      <li>previous iteration: ${options.previousIterationPath ? `<code>${escapeHtml(options.previousIterationPath)}</code>` : "not provided"}</li>
      <li>evals detected: ${escapeHtml(options.evalEntries.length)}</li>
    </ul>
  </header>
  ${benchmarkSection}
  ${againstPreviousSection}
  ${evalSections || "<p>No eval outputs were found.</p>"}
</body>
</html>\n`;
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

	const benchmarkPath = options.benchmark
		? path.resolve(String(options.benchmark))
		: existsSync(path.join(iterationPath, "benchmark.json"))
			? path.join(iterationPath, "benchmark.json")
			: undefined;
	const benchmark = benchmarkPath && existsSync(benchmarkPath) ? await readJson(benchmarkPath) : undefined;
	const blindComparisonVsPreviousSummaryPath = existsSync(path.join(iterationPath, "blind-comparison-vs-previous-summary.json"))
		? path.join(iterationPath, "blind-comparison-vs-previous-summary.json")
		: undefined;
	const blindComparisonVsPreviousSummary = blindComparisonVsPreviousSummaryPath
		? await readJson(blindComparisonVsPreviousSummaryPath)
		: undefined;
	const iterationJsonPath = path.join(iterationPath, "iteration.json");
	const iterationJson = existsSync(iterationJsonPath) ? await readJson(iterationJsonPath) : {};
	const skillName =
		String(options.skillName ?? "").trim() ||
		(typeof iterationJson.skillPath === "string" && iterationJson.skillPath ? path.basename(iterationJson.skillPath) : path.basename(path.dirname(iterationPath)));
	const previousIterationPath = options.previousIteration ? path.resolve(String(options.previousIteration)) : undefined;
	const outputPath = path.resolve(String(options.output ?? path.join(iterationPath, "review.html")));
	const evalEntries = await discoverEvalEntries(iterationPath);
	const html = renderHtml({
		skillName,
		iterationPath,
		benchmark,
		benchmarkPath,
		previousIterationPath,
		blindComparisonVsPreviousSummary,
		generatedAt: new Date().toISOString(),
		evalEntries,
	});

	await writeText(outputPath, html);

	console.log(`Review written:`);
	console.log(`- html: ${outputPath}`);
	console.log(`Evals: ${evalEntries.length}`);
	console.log(`Benchmark: ${benchmarkPath ?? "not provided"}`);
}

main().catch((error) => {
	console.error(`[generate-review] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
