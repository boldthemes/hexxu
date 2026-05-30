#!/usr/bin/env -S node --experimental-strip-types

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "..", "aggregate-benchmark.ts");

async function makeWorkdir() {
	return await mkdtemp(path.join(tmpdir(), "aggregate-benchmark-test-"));
}

async function writeJsonFile(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonFile(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

function runAggregate(iterationPath, extraArgs = []) {
	return spawnSync(
		"node",
		[
			"--experimental-strip-types",
			SCRIPT,
			"--iteration-path",
			iterationPath,
			...extraArgs,
		],
		{ encoding: "utf8" },
	);
}

/**
 * Build a minimal happy-path iteration fixture on disk.
 *
 *   iteration-1/
 *     iteration.json
 *     eval-001-test/
 *       eval_metadata.json
 *       with-skill/
 *         outputs/assistant-final.md
 *         transcript.md, run.json, metrics.json, timing.json, grading.json
 *       without-skill/
 *         (same)
 *
 * Each artifact can be skipped via opts to exercise missing-file paths.
 */
async function buildBasicFixture(workdir, opts = {}) {
	const iterationPath = path.join(workdir, "iteration-1");
	await mkdir(iterationPath, { recursive: true });

	await writeJsonFile(path.join(iterationPath, "iteration.json"), {
		skillPath: "/fake/skill",
		workspacePath: workdir,
		cwd: workdir,
		evalSetPath: "/fake/evals.json",
		iteration: 1,
		baselineMode: "without-skill",
		model: "fake/model",
		thinking: "low",
		runsPerEval: 1,
		evals: [],
	});

	const evalDir = path.join(iterationPath, "eval-001-test");
	await mkdir(evalDir, { recursive: true });
	await writeJsonFile(path.join(evalDir, "eval_metadata.json"), {
		evalId: "001",
		evalName: "test",
		prompt: "test prompt",
		expectedOutput: null,
		expectations: [],
		files: [],
		configurations: ["with-skill", "without-skill"],
	});

	for (const config of ["with-skill", "without-skill"]) {
		const configDir = path.join(evalDir, config);
		await mkdir(path.join(configDir, "outputs"), { recursive: true });
		await writeFile(
			path.join(configDir, "outputs", "assistant-final.md"),
			"final text\n",
		);
		await writeFile(path.join(configDir, "transcript.md"), "# Transcript\n");

		if (!opts.skipMetrics) {
			await writeJsonFile(path.join(configDir, "metrics.json"), {
				toolExecutionStarts: 3,
				toolExecutionEnds: 3,
				toolErrors: 0,
				messageCount: 6,
				finalAssistantChars: 100,
				outputFiles: [],
			});
		}

		if (!opts.skipTiming) {
			await writeJsonFile(path.join(configDir, "timing.json"), {
				startedAt: "2026-01-01T00:00:00Z",
				endedAt: "2026-01-01T00:00:05Z",
				durationMs: 5000,
				totalDurationSeconds: 5.0,
			});
		}

		if (!opts.skipRun) {
			await writeJsonFile(path.join(configDir, "run.json"), {
				configuration: config,
				runNumber: 1,
				skillPath: config === "with-skill" ? "/fake/skill" : null,
				prompt: "test prompt",
				inputFiles: [],
				model: "fake/model",
				thinking: "low",
				success: true,
				errorMessage: null,
				finalAssistantChars: 100,
			});
		}

		if (!opts.skipGrading) {
			await writeJsonFile(path.join(configDir, "grading.json"), {
				summary: { passed: 1, failed: 0, total: 1, pass_rate: 1.0 },
			});
		}
	}

	return iterationPath;
}

async function addVsPreviousSummary(iterationPath) {
	await writeJsonFile(
		path.join(iterationPath, "blind-comparison-vs-previous-summary.json"),
		{
			generated_at: "2026-01-01T00:00:00Z",
			scope: "vs-previous-iteration",
			iteration_path: iterationPath,
			previous_iteration_path: "/fake/iteration-0",
			model: "fake/model",
			thinking: "low",
			eval_count: 1,
			comparison_count: 3,
			successful_comparisons: 3,
			failed_comparisons: 0,
			current_wins: 2,
			previous_wins: 0,
			ties: 1,
			current_win_rate: 0.667,
			previous_win_rate: 0,
			overall_winner: "current",
			by_configuration: [
				{
					configuration: "with-skill",
					current_wins: 2,
					previous_wins: 0,
					ties: 1,
					comparisons: 3,
					current_win_rate: 0.667,
					previous_win_rate: 0,
					average_eval_current_win_rate: 0.667,
					average_eval_previous_win_rate: 0,
					winner: "current",
				},
			],
			evals: [],
		},
	);
}

describe("aggregate-benchmark", () => {
	test("happy path: produces benchmark.json with overall + by_configuration stats and benchmark.md sections", async () => {
		const wd = await makeWorkdir();
		try {
			const iterPath = await buildBasicFixture(wd);
			const result = runAggregate(iterPath);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const benchmark = await readJsonFile(path.join(iterPath, "benchmark.json"));
			assert.equal(benchmark.metadata.evals_detected, 1);
			assert.equal(benchmark.metadata.run_count, 2);
			assert.deepEqual(benchmark.metadata.configurations.slice().sort(), [
				"with-skill",
				"without-skill",
			]);
			assert.equal(benchmark.summaries.overall.successful_runs, 2);
			assert.equal(benchmark.summaries.overall.failed_runs, 0);
			assert.equal(benchmark.summaries.overall.success_rate, 1);
			assert.equal(benchmark.summaries.by_configuration.length, 2);

			const md = await readFile(path.join(iterPath, "benchmark.md"), "utf8");
			assert.match(md, /# Benchmark Summary/);
			assert.match(md, /## Overall/);
			assert.match(md, /## By Configuration/);
			assert.match(md, /## By Eval/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	test("missing metrics.json: metric-derived fields fall back to null", async () => {
		const wd = await makeWorkdir();
		try {
			const iterPath = await buildBasicFixture(wd, { skipMetrics: true });
			const result = runAggregate(iterPath);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const benchmark = await readJsonFile(path.join(iterPath, "benchmark.json"));
			assert.equal(benchmark.metadata.run_count, 2);
			for (const summary of benchmark.summaries.by_configuration) {
				assert.equal(summary.average_message_count, null);
			}
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	test("missing timing.json: average duration becomes null", async () => {
		const wd = await makeWorkdir();
		try {
			const iterPath = await buildBasicFixture(wd, { skipTiming: true });
			const result = runAggregate(iterPath);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const benchmark = await readJsonFile(path.join(iterPath, "benchmark.json"));
			assert.equal(benchmark.summaries.overall.average_duration_seconds, null);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	test("missing run.json: configuration is silently skipped", async () => {
		const wd = await makeWorkdir();
		try {
			const iterPath = await buildBasicFixture(wd, { skipRun: true });
			const result = runAggregate(iterPath);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const benchmark = await readJsonFile(path.join(iterPath, "benchmark.json"));
			assert.equal(benchmark.metadata.run_count, 0);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	test("partial iteration: one configuration missing run.json does not crash; other configurations still aggregate", async () => {
		const wd = await makeWorkdir();
		try {
			const iterPath = await buildBasicFixture(wd);
			await rm(
				path.join(iterPath, "eval-001-test", "without-skill", "run.json"),
			);
			const result = runAggregate(iterPath);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const benchmark = await readJsonFile(path.join(iterPath, "benchmark.json"));
			assert.equal(benchmark.metadata.run_count, 1);
			const configs = benchmark.summaries.by_configuration.map(
				(entry) => entry.configuration,
			);
			assert.deepEqual(configs, ["with-skill"]);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	test("T10: vs-previous summary populates metadata + overall.vs_previous + by_configuration_vs_previous", async () => {
		const wd = await makeWorkdir();
		try {
			const iterPath = await buildBasicFixture(wd);
			await addVsPreviousSummary(iterPath);
			const result = runAggregate(iterPath);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const benchmark = await readJsonFile(path.join(iterPath, "benchmark.json"));

			assert.ok(
				benchmark.metadata.blind_comparison_vs_previous_summary_path?.endsWith(
					"blind-comparison-vs-previous-summary.json",
				),
				"metadata path should point at the cross-iteration summary file",
			);

			const vp = benchmark.summaries.overall.vs_previous;
			assert.ok(vp, "vs_previous block should be populated");
			assert.equal(vp.current_wins, 2);
			assert.equal(vp.previous_wins, 0);
			assert.equal(vp.ties, 1);
			assert.equal(vp.current_win_rate, 0.667);
			assert.equal(vp.overall_winner, "current");
			assert.equal(vp.previous_iteration_path, "/fake/iteration-0");

			assert.equal(benchmark.summaries.by_configuration_vs_previous.length, 1);
			assert.equal(
				benchmark.summaries.by_configuration_vs_previous[0].winner,
				"current",
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	test("T10: no vs-previous summary -> vs_previous is null, by_configuration_vs_previous is empty, path is null", async () => {
		const wd = await makeWorkdir();
		try {
			const iterPath = await buildBasicFixture(wd);
			const result = runAggregate(iterPath);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const benchmark = await readJsonFile(path.join(iterPath, "benchmark.json"));
			assert.equal(
				benchmark.metadata.blind_comparison_vs_previous_summary_path,
				null,
			);
			assert.equal(benchmark.summaries.overall.vs_previous, null);
			assert.deepEqual(benchmark.summaries.by_configuration_vs_previous, []);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	test("T10: vs-previous markdown section renders only when summary file exists", async () => {
		const wd1 = await makeWorkdir();
		const wd2 = await makeWorkdir();
		try {
			const iterPath1 = await buildBasicFixture(wd1);
			runAggregate(iterPath1);
			const md1 = await readFile(path.join(iterPath1, "benchmark.md"), "utf8");
			assert.doesNotMatch(md1, /## Versus Previous Iteration/);

			const iterPath2 = await buildBasicFixture(wd2);
			await addVsPreviousSummary(iterPath2);
			runAggregate(iterPath2);
			const md2 = await readFile(path.join(iterPath2, "benchmark.md"), "utf8");
			assert.match(md2, /## Versus Previous Iteration/);
			assert.match(md2, /- current wins: 2/);
			assert.match(md2, /- previous wins: 0/);
			assert.match(md2, /- overall winner: current/);
			assert.match(md2, /### By Configuration vs Previous/);
		} finally {
			await rm(wd1, { recursive: true, force: true });
			await rm(wd2, { recursive: true, force: true });
		}
	});

	test("--help exits 0 and prints usage", () => {
		const result = spawnSync(
			"node",
			["--experimental-strip-types", SCRIPT, "--help"],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /Usage:/);
		assert.match(result.stdout, /--iteration-path/);
	});

	test("missing --iteration-path returns non-zero and explains", () => {
		const result = spawnSync(
			"node",
			["--experimental-strip-types", SCRIPT],
			{ encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /--iteration-path is required/);
	});

	test("nonexistent --iteration-path returns non-zero and explains", () => {
		const result = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				SCRIPT,
				"--iteration-path",
				"/nonexistent/iteration/path",
			],
			{ encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /does not exist/);
	});
});
