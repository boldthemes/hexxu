import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";

type BaselineMode = "none" | "without-skill" | "snapshot";

interface SkillCreatorState {
	targetSkillPath?: string;
	workspacePath?: string;
	lastIteration?: number;
	lastIterationPath?: string;
	lastGradingPath?: string;
	lastBlindComparisonPath?: string;
	lastBlindComparisonVsPreviousPath?: string;
	lastBenchmarkPath?: string;
	lastReviewArtifactPath?: string;
	preferredBaselineMode?: BaselineMode;
	snapshotPath?: string;
	lastOptimizationRunPath?: string;
}

const STATE_ENTRY_TYPE = "skill-creator-state";
const STATUS_KEY = "skill-creator";
const BASELINE_MODES: BaselineMode[] = ["without-skill", "none", "snapshot"];

function normalizePathInput(rawPath: string): string {
	const trimmed = rawPath.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function resolveUserPath(rawPath: string, cwd: string): string {
	return resolve(cwd, normalizePathInput(rawPath));
}

function defaultSkillPath(ctx: ExtensionContext, state: SkillCreatorState): string {
	return state.targetSkillPath ?? join(ctx.cwd, ".pi", "skills", "my-skill");
}

function defaultWorkspacePath(skillPath: string, state: SkillCreatorState): string {
	if (state.workspacePath && state.targetSkillPath === skillPath) {
		return state.workspacePath;
	}

	const skillName = basename(skillPath);
	const skillParent = dirname(skillPath);

	if (basename(skillParent) === "skills") {
		return join(dirname(skillParent), "skill-workspaces", skillName);
	}

	return join(skillParent, `${skillName}-workspace`);
}

function ensureDirectoryPath(path: string, label: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
		return;
	}

	const stats = statSync(path);
	if (!stats.isDirectory()) {
		throw new Error(`${label} exists but is not a directory: ${path}`);
	}
}

function createDirectoryIfMissing(path: string, label: string): string | undefined {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
		return path;
	}

	const stats = statSync(path);
	if (!stats.isDirectory()) {
		throw new Error(`${label} exists but is not a directory: ${path}`);
	}

	return undefined;
}

function writeStarterSkillFile(skillPath: string, overwrite = false): string | undefined {
	const skillMdPath = join(skillPath, "SKILL.md");
	if (existsSync(skillMdPath) && !overwrite) {
		return undefined;
	}

	const skillName = basename(skillPath)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/--+/g, "-") || "my-skill";

	writeFileSync(
		skillMdPath,
		`---\nname: ${skillName}\ndescription: Describe what this skill does and when pi should use it.\n---\n\n# ${basename(skillPath)}\n\n## Purpose\n\nDescribe the skill's goal here.\n\n## Workflow\n\n1. Capture the user's intent.\n2. Explain the main steps the skill should follow.\n3. Add supporting references if the main file grows too large.\n`,
		"utf8",
	);

	return skillMdPath;
}

function writeStarterEvalsFile(skillPath: string, overwrite = false): string | undefined {
	const evalsDir = join(skillPath, "evals");
	ensureDirectoryPath(evalsDir, "Evals directory");

	const evalsPath = join(evalsDir, "evals.json");
	if (existsSync(evalsPath) && !overwrite) {
		return undefined;
	}

	writeFileSync(
		evalsPath,
		`${JSON.stringify(
			{
				skill_name: basename(skillPath),
				evals: [
					{
						id: 1,
						prompt: "Replace this with a realistic eval prompt.",
						expected_output: "Describe what success looks like.",
						files: [],
					},
				],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	return evalsPath;
}

function restoreState(ctx: ExtensionContext, current: SkillCreatorState): SkillCreatorState {
	let restored: SkillCreatorState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && entry.data) {
			restored = entry.data as SkillCreatorState;
		}
	}

	return restored ?? current;
}

function prepareTargetPaths(targetSkillPath: string, workspacePath: string, createMissingDirs: boolean): string[] {
	const createdPaths: string[] = [];

	if (createMissingDirs) {
		const createdSkillDir = createDirectoryIfMissing(targetSkillPath, "Skill directory");
		const createdReferencesDir = createDirectoryIfMissing(join(targetSkillPath, "references"), "References directory");
		const createdWorkspaceDir = createDirectoryIfMissing(workspacePath, "Workspace directory");

		if (createdSkillDir) createdPaths.push(createdSkillDir);
		if (createdReferencesDir) createdPaths.push(createdReferencesDir);
		if (createdWorkspaceDir) createdPaths.push(createdWorkspaceDir);
		return createdPaths;
	}

	if (!existsSync(targetSkillPath)) {
		throw new Error("Skill path does not exist. Re-run with directory creation enabled.");
	}

	const stats = statSync(targetSkillPath);
	if (!stats.isDirectory()) {
		throw new Error(`Skill path exists but is not a directory: ${targetSkillPath}`);
	}

	return createdPaths;
}

interface ValidationIssue {
	level: "error" | "warning";
	message: string;
}

function formatPresence(path: string | undefined, label: string): string {
	if (!path) {
		return `${label}: not set`;
	}
	return `${label}: ${existsSync(path) ? "yes" : "no"}`;
}

function parseFrontmatterFields(skillMdContent: string): {
	hasFrontmatter: boolean;
	name?: string;
	description?: string;
	yamlError?: string;
} {
	const normalized = skillMdContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	const delimiter = /^---[ \t]*$/;
	if (!delimiter.test(lines[0] ?? "")) {
		return { hasFrontmatter: false };
	}

	let lastError: unknown;
	for (let i = 1; i < lines.length; i++) {
		if (!delimiter.test(lines[i] ?? "")) {
			continue;
		}

		try {
			const parsed = parse(lines.slice(1, i).join("\n"));
			const fields: { hasFrontmatter: boolean; name?: string; description?: string; yamlError?: string } = {
				hasFrontmatter: true,
			};
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				if (typeof parsed.name === "string") fields.name = parsed.name;
				if (typeof parsed.description === "string") fields.description = parsed.description;
			}
			return fields;
		} catch (error) {
			lastError = error;
		}
	}

	if (lastError) {
		return {
			hasFrontmatter: true,
			yamlError: lastError instanceof Error ? lastError.message : String(lastError),
		};
	}

	return { hasFrontmatter: false };
}

function validateSkillPath(skillPath: string): { valid: boolean; issues: ValidationIssue[] } {
	const issues: ValidationIssue[] = [];

	if (!existsSync(skillPath)) {
		issues.push({ level: "error", message: `Skill path does not exist: ${skillPath}` });
		return { valid: false, issues };
	}

	const skillStats = statSync(skillPath);
	if (!skillStats.isDirectory()) {
		issues.push({ level: "error", message: `Skill path is not a directory: ${skillPath}` });
		return { valid: false, issues };
	}

	const skillMdPath = join(skillPath, "SKILL.md");
	if (!existsSync(skillMdPath)) {
		issues.push({ level: "error", message: `Missing SKILL.md: ${skillMdPath}` });
		return { valid: false, issues };
	}

	const skillMdStats = statSync(skillMdPath);
	if (!skillMdStats.isFile()) {
		issues.push({ level: "error", message: `SKILL.md is not a file: ${skillMdPath}` });
		return { valid: false, issues };
	}

	const skillMdContent = readFileSync(skillMdPath, "utf8");
	const frontmatter = parseFrontmatterFields(skillMdContent);

	if (!frontmatter.hasFrontmatter) {
		issues.push({ level: "error", message: "SKILL.md is missing valid frontmatter delimited by ---" });
	} else if (frontmatter.yamlError) {
		issues.push({ level: "error", message: `Invalid YAML frontmatter: ${frontmatter.yamlError}` });
	} else {
		if (!frontmatter.name) {
			issues.push({ level: "error", message: "Frontmatter is missing required field: name" });
		} else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name)) {
			issues.push({
				level: "error",
				message: `Frontmatter name is invalid: ${frontmatter.name}. Use lowercase letters, numbers, and hyphens.`,
			});
		}

		if (!frontmatter.description) {
			issues.push({ level: "error", message: "Frontmatter is missing required field: description" });
		}
	}

	const referencesPath = join(skillPath, "references");
	if (existsSync(referencesPath) && !statSync(referencesPath).isDirectory()) {
		issues.push({ level: "error", message: `references exists but is not a directory: ${referencesPath}` });
	}

	const scriptsPath = join(skillPath, "scripts");
	if (existsSync(scriptsPath) && !statSync(scriptsPath).isDirectory()) {
		issues.push({ level: "error", message: `scripts exists but is not a directory: ${scriptsPath}` });
	}

	const assetsPath = join(skillPath, "assets");
	if (existsSync(assetsPath) && !statSync(assetsPath).isDirectory()) {
		issues.push({ level: "error", message: `assets exists but is not a directory: ${assetsPath}` });
	}

	const evalsPath = join(skillPath, "evals");
	if (existsSync(evalsPath)) {
		if (!statSync(evalsPath).isDirectory()) {
			issues.push({ level: "error", message: `evals exists but is not a directory: ${evalsPath}` });
		} else if (!existsSync(join(evalsPath, "evals.json"))) {
			issues.push({ level: "warning", message: `evals/ exists but evals/evals.json is missing: ${join(evalsPath, "evals.json")}` });
		}
	}

	return {
		valid: !issues.some((issue) => issue.level === "error"),
		issues,
	};
}

function buildValidationSummary(skillPath: string, result: { valid: boolean; issues: ValidationIssue[] }) {
	const errorCount = result.issues.filter((issue) => issue.level === "error").length;
	const warningCount = result.issues.filter((issue) => issue.level === "warning").length;
	const lines = [
		`skill path: ${skillPath}`,
		`valid: ${result.valid ? "yes" : "no"}`,
		`errors: ${errorCount}`,
		`warnings: ${warningCount}`,
	];

	if (result.issues.length > 0) {
		lines.push("issues:");
		for (const issue of result.issues) {
			lines.push(`- ${issue.level}: ${issue.message}`);
		}
	} else {
		lines.push("issues:\n- none");
	}

	return { errorCount, warningCount, text: lines.join("\n") };
}

interface RunEvalsPlan {
	skillPath: string;
	workspacePath: string;
	evalsPath: string;
	iteration: number;
	baselineMode: BaselineMode;
	snapshotPath?: string;
	scriptPath: string;
	scriptExists: boolean;
	issues: string[];
	warnings: string[];
}

interface ComparePlan {
	skillPath: string;
	iterationPath: string;
	previousIterationPath?: string;
	evalsPath: string;
	summaryPath: string;
	previousSummaryPath?: string;
	scriptPath: string;
	scriptExists: boolean;
	issues: string[];
	warnings: string[];
}

interface BenchmarkPlan {
	skillPath: string;
	iterationPath: string;
	scriptPath: string;
	scriptExists: boolean;
	benchmarkJsonPath: string;
	benchmarkMdPath: string;
	issues: string[];
	warnings: string[];
}

interface ReviewPlan {
	skillPath: string;
	iterationPath: string;
	benchmarkPath?: string;
	previousIterationPath?: string;
	reviewPath: string;
	scriptPath: string;
	scriptExists: boolean;
	issues: string[];
	warnings: string[];
}

interface GradePlan {
	skillPath: string;
	iterationPath: string;
	evalsPath: string;
	summaryPath: string;
	scriptPath: string;
	scriptExists: boolean;
	issues: string[];
	warnings: string[];
}

function inferProjectRootFromSkillPath(skillPath: string): string {
	const parent = dirname(skillPath);
	const grandparent = dirname(parent);
	if (basename(parent) === "skills" && basename(grandparent) === ".pi") {
		return dirname(grandparent);
	}
	return dirname(skillPath);
}

function getRunEvalsScriptPath(skillPath: string): string {
	const projectRoot = inferProjectRootFromSkillPath(skillPath);
	return join(projectRoot, ".pi", "sdk", "skill-creator", "run-evals.ts");
}

function getGradeIterationScriptPath(skillPath: string): string {
	const projectRoot = inferProjectRootFromSkillPath(skillPath);
	return join(projectRoot, ".pi", "sdk", "skill-creator", "grade-iteration.ts");
}

function getCompareIterationScriptPath(skillPath: string): string {
	const projectRoot = inferProjectRootFromSkillPath(skillPath);
	return join(projectRoot, ".pi", "sdk", "skill-creator", "compare-iteration.ts");
}

function getAggregateBenchmarkScriptPath(skillPath: string): string {
	const projectRoot = inferProjectRootFromSkillPath(skillPath);
	return join(projectRoot, ".pi", "sdk", "skill-creator", "aggregate-benchmark.ts");
}

function getGenerateReviewScriptPath(skillPath: string): string {
	const projectRoot = inferProjectRootFromSkillPath(skillPath);
	return join(projectRoot, ".pi", "sdk", "skill-creator", "generate-review.ts");
}

function getOptimizeDescriptionScriptPath(skillPath: string): string {
	const projectRoot = inferProjectRootFromSkillPath(skillPath);
	return join(projectRoot, ".pi", "sdk", "skill-creator", "optimize-description.ts");
}

function orderedBaselineModes(preferred: BaselineMode): string[] {
	return [preferred, ...BASELINE_MODES.filter((mode) => mode !== preferred)];
}

function resolveBaselineMode(value: string | undefined, fallback: BaselineMode): BaselineMode {
	if (value && BASELINE_MODES.includes(value as BaselineMode)) {
		return value as BaselineMode;
	}
	return fallback;
}

function buildRunEvalsPlan(
	state: SkillCreatorState,
	options: {
		skillPath?: string;
		workspacePath?: string;
		iteration: number;
		baselineMode: BaselineMode;
		snapshotPath?: string;
	},
): RunEvalsPlan {
	const skillPath = options.skillPath ?? state.targetSkillPath;
	if (!skillPath) {
		throw new Error("No active target skill is set. Use /skill-init or skill_creator_set_target first.");
	}

	const workspacePath = options.workspacePath ?? state.workspacePath ?? defaultWorkspacePath(skillPath, state);
	const evalsPath = join(skillPath, "evals", "evals.json");
	const scriptPath = getRunEvalsScriptPath(skillPath);
	const issues: string[] = [];
	const warnings: string[] = [];

	if (!existsSync(skillPath)) {
		issues.push(`Skill path does not exist: ${skillPath}`);
	} else if (!statSync(skillPath).isDirectory()) {
		issues.push(`Skill path is not a directory: ${skillPath}`);
	}

	if (!existsSync(workspacePath)) {
		issues.push(`Workspace path does not exist: ${workspacePath}`);
	} else if (!statSync(workspacePath).isDirectory()) {
		issues.push(`Workspace path is not a directory: ${workspacePath}`);
	}

	if (!existsSync(evalsPath)) {
		issues.push(`Eval set is missing: ${evalsPath}`);
	}

	if (options.iteration < 1 || !Number.isInteger(options.iteration)) {
		issues.push(`Iteration must be a positive integer: ${options.iteration}`);
	}

	const resolvedSnapshotPath = options.snapshotPath ?? state.snapshotPath;
	if (options.baselineMode === "snapshot") {
		if (!resolvedSnapshotPath) {
			issues.push(
				"Baseline mode 'snapshot' requires a snapshot skill path. Use /skill-set-snapshot or pass snapshotPath explicitly.",
			);
		} else if (!existsSync(resolvedSnapshotPath)) {
			issues.push(`Snapshot path does not exist: ${resolvedSnapshotPath}`);
		} else if (!statSync(resolvedSnapshotPath).isDirectory()) {
			issues.push(`Snapshot path is not a directory: ${resolvedSnapshotPath}`);
		} else if (!existsSync(join(resolvedSnapshotPath, "SKILL.md"))) {
			issues.push(`Snapshot path does not contain SKILL.md: ${resolvedSnapshotPath}`);
		}
	}

	const scriptExists = existsSync(scriptPath);
	if (!scriptExists) {
		warnings.push(`Expected SDK runner is not implemented yet: ${scriptPath}`);
	}

	return {
		skillPath,
		workspacePath,
		evalsPath,
		iteration: options.iteration,
		baselineMode: options.baselineMode,
		snapshotPath: options.baselineMode === "snapshot" ? resolvedSnapshotPath : undefined,
		scriptPath,
		scriptExists,
		issues,
		warnings,
	};
}

function buildRunEvalsSummary(plan: RunEvalsPlan): string {
	const lines = [
		"Skill run-evals plan",
		`skill path: ${plan.skillPath}`,
		`workspace path: ${plan.workspacePath}`,
		`eval set: ${plan.evalsPath}`,
		`iteration: ${plan.iteration}`,
		`baseline mode: ${plan.baselineMode}`,
		`snapshot path: ${plan.snapshotPath ?? (plan.baselineMode === "snapshot" ? "not set" : "n/a")}`,
		`expected sdk runner: ${plan.scriptPath}`,
		`runner present: ${plan.scriptExists ? "yes" : "no"}`,
	];

	if (plan.issues.length > 0) {
		lines.push("issues:");
		for (const issue of plan.issues) {
			lines.push(`- error: ${issue}`);
		}
	} else {
		lines.push("issues:\n- none");
	}

	if (plan.warnings.length > 0) {
		lines.push("warnings:");
		for (const warning of plan.warnings) {
			lines.push(`- ${warning}`);
		}
	} else {
		lines.push("warnings:\n- none");
	}

	if (plan.issues.length === 0 && plan.scriptExists) {
		lines.push("status: ready to execute the SDK runner.");
	} else if (plan.issues.length === 0) {
		lines.push("status: configuration looks reasonable, but the SDK runner is not implemented yet.");
	} else {
		lines.push("status: fix the issues above before eval execution can run.");
	}

	return lines.join("\n");
}

function buildRunEvalsExecArgs(
	plan: RunEvalsPlan,
	ctx: ExtensionContext,
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
): string[] {
	const args = [
		"--experimental-strip-types",
		plan.scriptPath,
		"--skill-path",
		plan.skillPath,
		"--workspace",
		plan.workspacePath,
		"--eval-set",
		plan.evalsPath,
		"--iteration",
		String(plan.iteration),
		"--baseline-mode",
		plan.baselineMode,
		"--cwd",
		inferProjectRootFromSkillPath(plan.skillPath),
	];

	if (plan.snapshotPath) {
		args.push("--snapshot-path", plan.snapshotPath);
	}

	if (ctx.model) {
		args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
	}

	if (thinkingLevel) {
		args.push("--thinking", thinkingLevel);
	}

	return args;
}

function defaultIterationPath(state: SkillCreatorState): string | undefined {
	if (state.lastIterationPath) {
		return state.lastIterationPath;
	}

	if (state.workspacePath && state.lastIteration !== undefined) {
		return join(state.workspacePath, `iteration-${state.lastIteration}`);
	}

	return undefined;
}

function guessPreviousIterationPath(iterationPath: string): string | undefined {
	const match = basename(iterationPath).match(/^iteration-(\d+)$/);
	if (!match) {
		return undefined;
	}

	const iteration = Number.parseInt(match[1], 10);
	if (!Number.isInteger(iteration) || iteration <= 1) {
		return undefined;
	}

	return join(dirname(iterationPath), `iteration-${iteration - 1}`);
}

function buildGradePlan(
	state: SkillCreatorState,
	options: { skillPath?: string; iterationPath?: string },
): GradePlan {
	const skillPath = options.skillPath ?? state.targetSkillPath;
	if (!skillPath) {
		throw new Error("No active target skill is set. Use /skill-init or skill_creator_set_target first.");
	}

	const iterationPath = options.iterationPath ?? defaultIterationPath(state);
	if (!iterationPath) {
		throw new Error("No iteration path is known. Run evals first or provide an iteration path.");
	}

	const evalsPath = join(skillPath, "evals", "evals.json");
	const summaryPath = join(iterationPath, "grading-summary.json");
	const scriptPath = getGradeIterationScriptPath(skillPath);
	const issues: string[] = [];
	const warnings: string[] = [];

	if (!existsSync(skillPath)) {
		issues.push(`Skill path does not exist: ${skillPath}`);
	} else if (!statSync(skillPath).isDirectory()) {
		issues.push(`Skill path is not a directory: ${skillPath}`);
	}

	if (!existsSync(iterationPath)) {
		issues.push(`Iteration path does not exist: ${iterationPath}`);
	} else if (!statSync(iterationPath).isDirectory()) {
		issues.push(`Iteration path is not a directory: ${iterationPath}`);
	}

	if (!existsSync(evalsPath)) {
		warnings.push(`Eval set is missing; grading will rely only on eval_metadata.json expectations: ${evalsPath}`);
	}

	const scriptExists = existsSync(scriptPath);
	if (!scriptExists) {
		warnings.push(`Expected grading script is not implemented yet: ${scriptPath}`);
	}

	return {
		skillPath,
		iterationPath,
		evalsPath,
		summaryPath,
		scriptPath,
		scriptExists,
		issues,
		warnings,
	};
}

function buildGradeSummary(plan: GradePlan): string {
	const lines = [
		"Skill grading plan",
		`skill path: ${plan.skillPath}`,
		`iteration path: ${plan.iterationPath}`,
		`eval set: ${plan.evalsPath}`,
		`expected sdk runner: ${plan.scriptPath}`,
		`runner present: ${plan.scriptExists ? "yes" : "no"}`,
		`grading summary: ${plan.summaryPath}`,
	];

	if (plan.issues.length > 0) {
		lines.push("issues:");
		for (const issue of plan.issues) {
			lines.push(`- error: ${issue}`);
		}
	} else {
		lines.push("issues:\n- none");
	}

	if (plan.warnings.length > 0) {
		lines.push("warnings:");
		for (const warning of plan.warnings) {
			lines.push(`- ${warning}`);
		}
	} else {
		lines.push("warnings:\n- none");
	}

	if (plan.issues.length === 0 && plan.scriptExists) {
		lines.push("status: ready to grade iteration artifacts.");
	} else if (plan.issues.length === 0) {
		lines.push("status: configuration looks reasonable, but the SDK runner is not implemented yet.");
	} else {
		lines.push("status: fix the issues above before grading can run.");
	}

	return lines.join("\n");
}

function buildGradeExecArgs(plan: GradePlan): string[] {
	const args = [
		"--experimental-strip-types",
		plan.scriptPath,
		"--iteration-path",
		plan.iterationPath,
		"--output-summary",
		plan.summaryPath,
	];

	if (existsSync(plan.evalsPath)) {
		args.push("--eval-set", plan.evalsPath);
	}

	return args;
}

function buildComparePlan(
	state: SkillCreatorState,
	options: { skillPath?: string; iterationPath?: string; previousIterationPath?: string },
): ComparePlan {
	const skillPath = options.skillPath ?? state.targetSkillPath;
	if (!skillPath) {
		throw new Error("No active target skill is set. Use /skill-init or skill_creator_set_target first.");
	}

	const iterationPath = options.iterationPath ?? defaultIterationPath(state);
	if (!iterationPath) {
		throw new Error("No iteration path is known. Run evals first or provide an iteration path.");
	}

	const previousIterationPath = options.previousIterationPath;
	const evalsPath = join(skillPath, "evals", "evals.json");
	const summaryPath = join(iterationPath, "blind-comparison-summary.json");
	const previousSummaryPath = previousIterationPath
		? join(iterationPath, "blind-comparison-vs-previous-summary.json")
		: undefined;
	const scriptPath = getCompareIterationScriptPath(skillPath);
	const issues: string[] = [];
	const warnings: string[] = [];

	if (!existsSync(skillPath)) {
		issues.push(`Skill path does not exist: ${skillPath}`);
	} else if (!statSync(skillPath).isDirectory()) {
		issues.push(`Skill path is not a directory: ${skillPath}`);
	}

	if (!existsSync(iterationPath)) {
		issues.push(`Iteration path does not exist: ${iterationPath}`);
	} else if (!statSync(iterationPath).isDirectory()) {
		issues.push(`Iteration path is not a directory: ${iterationPath}`);
	}

	if (previousIterationPath && previousIterationPath === iterationPath) {
		warnings.push(`Previous iteration path matches the current iteration and will not provide a meaningful comparison: ${previousIterationPath}`);
	} else if (previousIterationPath && !existsSync(previousIterationPath)) {
		warnings.push(`Previous iteration path does not exist and will be omitted: ${previousIterationPath}`);
	}

	if (!existsSync(evalsPath)) {
		warnings.push(`Eval set is missing; blind comparison will rely only on eval_metadata.json expectations: ${evalsPath}`);
	}

	const scriptExists = existsSync(scriptPath);
	if (!scriptExists) {
		warnings.push(`Expected blind comparison script is not implemented yet: ${scriptPath}`);
	}

	return {
		skillPath,
		iterationPath,
		previousIterationPath,
		evalsPath,
		summaryPath,
		previousSummaryPath,
		scriptPath,
		scriptExists,
		issues,
		warnings,
	};
}

function buildCompareSummary(plan: ComparePlan): string {
	const lines = [
		"Skill blind-comparison plan",
		`skill path: ${plan.skillPath}`,
		`iteration path: ${plan.iterationPath}`,
		`previous iteration: ${plan.previousIterationPath ?? "not provided"}`,
		`eval set: ${plan.evalsPath}`,
		`expected sdk runner: ${plan.scriptPath}`,
		`runner present: ${plan.scriptExists ? "yes" : "no"}`,
		`comparison summary: ${plan.summaryPath}`,
		`comparison vs previous summary: ${plan.previousSummaryPath ?? "not requested"}`,
	];

	if (plan.issues.length > 0) {
		lines.push("issues:");
		for (const issue of plan.issues) {
			lines.push(`- error: ${issue}`);
		}
	} else {
		lines.push("issues:\n- none");
	}

	if (plan.warnings.length > 0) {
		lines.push("warnings:");
		for (const warning of plan.warnings) {
			lines.push(`- ${warning}`);
		}
	} else {
		lines.push("warnings:\n- none");
	}

	if (plan.issues.length === 0 && plan.scriptExists) {
		lines.push("status: ready to run blind output comparisons.");
	} else if (plan.issues.length === 0) {
		lines.push("status: configuration looks reasonable, but the SDK runner is not implemented yet.");
	} else {
		lines.push("status: fix the issues above before blind comparison can run.");
	}

	return lines.join("\n");
}

function buildCompareExecArgs(
	plan: ComparePlan,
	ctx: ExtensionContext,
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
): string[] {
	const args = [
		"--experimental-strip-types",
		plan.scriptPath,
		"--iteration-path",
		plan.iterationPath,
		"--output-summary",
		plan.summaryPath,
	];

	if (plan.previousIterationPath && plan.previousIterationPath !== plan.iterationPath && existsSync(plan.previousIterationPath)) {
		args.push("--previous-iteration", plan.previousIterationPath);
		if (plan.previousSummaryPath) {
			args.push("--output-vs-previous-summary", plan.previousSummaryPath);
		}
	}

	if (existsSync(plan.evalsPath)) {
		args.push("--eval-set", plan.evalsPath);
	}

	if (ctx.model) {
		args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
	}

	if (thinkingLevel) {
		args.push("--thinking", thinkingLevel);
	}

	return args;
}

function buildBenchmarkPlan(
	state: SkillCreatorState,
	options: { skillPath?: string; iterationPath?: string },
): BenchmarkPlan {
	const skillPath = options.skillPath ?? state.targetSkillPath;
	if (!skillPath) {
		throw new Error("No active target skill is set. Use /skill-init or skill_creator_set_target first.");
	}

	const iterationPath = options.iterationPath ?? defaultIterationPath(state);
	if (!iterationPath) {
		throw new Error("No iteration path is known. Run evals first or provide an iteration path.");
	}

	const scriptPath = getAggregateBenchmarkScriptPath(skillPath);
	const benchmarkJsonPath = join(iterationPath, "benchmark.json");
	const benchmarkMdPath = join(iterationPath, "benchmark.md");
	const issues: string[] = [];
	const warnings: string[] = [];

	if (!existsSync(skillPath)) {
		issues.push(`Skill path does not exist: ${skillPath}`);
	} else if (!statSync(skillPath).isDirectory()) {
		issues.push(`Skill path is not a directory: ${skillPath}`);
	}

	if (!existsSync(iterationPath)) {
		issues.push(`Iteration path does not exist: ${iterationPath}`);
	} else if (!statSync(iterationPath).isDirectory()) {
		issues.push(`Iteration path is not a directory: ${iterationPath}`);
	}

	const scriptExists = existsSync(scriptPath);
	if (!scriptExists) {
		warnings.push(`Expected benchmark script is not implemented yet: ${scriptPath}`);
	}

	if (existsSync(iterationPath) && !existsSync(join(iterationPath, "iteration.json"))) {
		warnings.push(`iteration.json is missing from the iteration directory: ${join(iterationPath, "iteration.json")}`);
	}

	return {
		skillPath,
		iterationPath,
		scriptPath,
		scriptExists,
		benchmarkJsonPath,
		benchmarkMdPath,
		issues,
		warnings,
	};
}

function buildBenchmarkSummary(plan: BenchmarkPlan): string {
	const lines = [
		"Skill benchmark plan",
		`skill path: ${plan.skillPath}`,
		`iteration path: ${plan.iterationPath}`,
		`expected sdk runner: ${plan.scriptPath}`,
		`runner present: ${plan.scriptExists ? "yes" : "no"}`,
		`benchmark json: ${plan.benchmarkJsonPath}`,
		`benchmark md: ${plan.benchmarkMdPath}`,
	];

	if (plan.issues.length > 0) {
		lines.push("issues:");
		for (const issue of plan.issues) {
			lines.push(`- error: ${issue}`);
		}
	} else {
		lines.push("issues:\n- none");
	}

	if (plan.warnings.length > 0) {
		lines.push("warnings:");
		for (const warning of plan.warnings) {
			lines.push(`- ${warning}`);
		}
	} else {
		lines.push("warnings:\n- none");
	}

	if (plan.issues.length === 0 && plan.scriptExists) {
		lines.push("status: ready to aggregate benchmark artifacts.");
	} else if (plan.issues.length === 0) {
		lines.push("status: configuration looks reasonable, but the SDK runner is not implemented yet.");
	} else {
		lines.push("status: fix the issues above before benchmark aggregation can run.");
	}

	return lines.join("\n");
}

function buildBenchmarkExecArgs(plan: BenchmarkPlan): string[] {
	return [
		"--experimental-strip-types",
		plan.scriptPath,
		"--iteration-path",
		plan.iterationPath,
		"--skill-name",
		basename(plan.skillPath),
		"--output-json",
		plan.benchmarkJsonPath,
		"--output-md",
		plan.benchmarkMdPath,
	];
}

function buildReviewPlan(
	state: SkillCreatorState,
	options: { skillPath?: string; iterationPath?: string; benchmarkPath?: string; previousIterationPath?: string },
): ReviewPlan {
	const skillPath = options.skillPath ?? state.targetSkillPath;
	if (!skillPath) {
		throw new Error("No active target skill is set. Use /skill-init or skill_creator_set_target first.");
	}

	const iterationPath = options.iterationPath ?? defaultIterationPath(state);
	if (!iterationPath) {
		throw new Error("No iteration path is known. Run evals first or provide an iteration path.");
	}

	const benchmarkPath = options.benchmarkPath ?? (existsSync(join(iterationPath, "benchmark.json")) ? join(iterationPath, "benchmark.json") : undefined);
	const previousIterationPath = options.previousIterationPath;
	const reviewPath = join(iterationPath, "review.html");
	const scriptPath = getGenerateReviewScriptPath(skillPath);
	const issues: string[] = [];
	const warnings: string[] = [];

	if (!existsSync(skillPath)) {
		issues.push(`Skill path does not exist: ${skillPath}`);
	} else if (!statSync(skillPath).isDirectory()) {
		issues.push(`Skill path is not a directory: ${skillPath}`);
	}

	if (!existsSync(iterationPath)) {
		issues.push(`Iteration path does not exist: ${iterationPath}`);
	} else if (!statSync(iterationPath).isDirectory()) {
		issues.push(`Iteration path is not a directory: ${iterationPath}`);
	}

	if (benchmarkPath && !existsSync(benchmarkPath)) {
		warnings.push(`Benchmark file does not exist and will be omitted: ${benchmarkPath}`);
	}
	if (!benchmarkPath) {
		warnings.push(`No benchmark.json was found for this iteration; the review will be generated without benchmark summary.`);
	}

	if (previousIterationPath && !existsSync(previousIterationPath)) {
		warnings.push(`Previous iteration path does not exist and will be omitted: ${previousIterationPath}`);
	}

	const scriptExists = existsSync(scriptPath);
	if (!scriptExists) {
		warnings.push(`Expected review script is not implemented yet: ${scriptPath}`);
	}

	return {
		skillPath,
		iterationPath,
		benchmarkPath,
		previousIterationPath,
		reviewPath,
		scriptPath,
		scriptExists,
		issues,
		warnings,
	};
}

function buildReviewSummary(plan: ReviewPlan): string {
	const lines = [
		"Skill review plan",
		`skill path: ${plan.skillPath}`,
		`iteration path: ${plan.iterationPath}`,
		`benchmark path: ${plan.benchmarkPath ?? "not provided"}`,
		`previous iteration: ${plan.previousIterationPath ?? "not provided"}`,
		`expected sdk runner: ${plan.scriptPath}`,
		`runner present: ${plan.scriptExists ? "yes" : "no"}`,
		`review html: ${plan.reviewPath}`,
	];

	if (plan.issues.length > 0) {
		lines.push("issues:");
		for (const issue of plan.issues) {
			lines.push(`- error: ${issue}`);
		}
	} else {
		lines.push("issues:\n- none");
	}

	if (plan.warnings.length > 0) {
		lines.push("warnings:");
		for (const warning of plan.warnings) {
			lines.push(`- ${warning}`);
		}
	} else {
		lines.push("warnings:\n- none");
	}

	if (plan.issues.length === 0 && plan.scriptExists) {
		lines.push("status: ready to generate a review artifact.");
	} else if (plan.issues.length === 0) {
		lines.push("status: configuration looks reasonable, but the SDK runner is not implemented yet.");
	} else {
		lines.push("status: fix the issues above before review generation can run.");
	}

	return lines.join("\n");
}

function buildReviewExecArgs(plan: ReviewPlan): string[] {
	const args = [
		"--experimental-strip-types",
		plan.scriptPath,
		"--iteration-path",
		plan.iterationPath,
		"--skill-name",
		basename(plan.skillPath),
		"--output",
		plan.reviewPath,
	];

	if (plan.benchmarkPath && existsSync(plan.benchmarkPath)) {
		args.push("--benchmark", plan.benchmarkPath);
	}

	if (plan.previousIterationPath && existsSync(plan.previousIterationPath)) {
		args.push("--previous-iteration", plan.previousIterationPath);
	}

	return args;
}

function buildStatusMessage(state: SkillCreatorState): string {
	if (!state.targetSkillPath) {
		return "Skill Creator has no active target. Use /skill-init to set a skill path.";
	}

	const skillMdPath = join(state.targetSkillPath, "SKILL.md");
	const referencesPath = join(state.targetSkillPath, "references");
	const evalsPath = join(state.targetSkillPath, "evals", "evals.json");

	return [
		"Skill Creator status",
		`skill path: ${state.targetSkillPath}`,
		`workspace path: ${state.workspacePath ?? "not set"}`,
		formatPresence(skillMdPath, "SKILL.md"),
		formatPresence(referencesPath, "references/"),
		formatPresence(evalsPath, "evals/evals.json"),
		`last iteration: ${state.lastIteration ?? "not set"}`,
		`last iteration path: ${state.lastIterationPath ?? "not set"}`,
		`last grading path: ${state.lastGradingPath ?? "not set"}`,
		`last blind comparison path: ${state.lastBlindComparisonPath ?? "not set"}`,
		`last blind comparison vs previous path: ${state.lastBlindComparisonVsPreviousPath ?? "not set"}`,
		`last benchmark path: ${state.lastBenchmarkPath ?? "not set"}`,
		`last review artifact path: ${state.lastReviewArtifactPath ?? "not set"}`,
		`preferred baseline: ${state.preferredBaselineMode ?? "without-skill"}`,
		`snapshot path: ${state.snapshotPath ?? "not set"}`,
		`last optimization run: ${state.lastOptimizationRunPath ?? "not set"}`,
	].join("\n");
}

function updateStatus(ctx: ExtensionContext, state: SkillCreatorState): void {
	if (!state.targetSkillPath) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	let text = `skill:${basename(state.targetSkillPath)}`;
	if (state.lastIteration !== undefined) {
		text += ` i${state.lastIteration}`;
	}
	ctx.ui.setStatus(STATUS_KEY, text);
}

export default function skillCreatorExtension(pi: ExtensionAPI) {
	let state: SkillCreatorState = {};

	const applyRestoredState = (ctx: ExtensionContext) => {
		state = restoreState(ctx, state);
		updateStatus(ctx, state);
	};

	const persistState = (nextState: SkillCreatorState, ctx: ExtensionContext) => {
		state = nextState;
		pi.appendEntry(STATE_ENTRY_TYPE, state);
		updateStatus(ctx, state);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyRestoredState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		applyRestoredState(ctx);
	});

	pi.registerCommand("skill-init", {
		description: "Initialize or register a skill workspace",
		handler: async (args, ctx) => {
			applyRestoredState(ctx);
			const rawArg = args.trim();
			const targetInput = rawArg || (await ctx.ui.input("Target skill path:", defaultSkillPath(ctx, state)));

			if (!targetInput?.trim()) {
				ctx.ui.notify("Cancelled skill initialization", "warning");
				return;
			}

			const targetSkillPath = resolveUserPath(targetInput, ctx.cwd);
			if (existsSync(targetSkillPath) && !statSync(targetSkillPath).isDirectory()) {
				ctx.ui.notify(`Skill path exists but is not a directory: ${targetSkillPath}`, "error");
				return;
			}

			const workspaceInput = await ctx.ui.input(
				"Workspace path:",
				defaultWorkspacePath(targetSkillPath, state),
			);

			if (!workspaceInput?.trim()) {
				ctx.ui.notify("Cancelled skill initialization", "warning");
				return;
			}

			const workspacePath = resolveUserPath(workspaceInput, ctx.cwd);
			const shouldScaffold = await ctx.ui.confirm(
				"Scaffold missing files?",
				[
					"Create missing directories and starter files?",
					"",
					`Skill: ${targetSkillPath}`,
					`Workspace: ${workspacePath}`,
				].join("\n"),
			);

			let createdPaths: string[] = [];

			try {
				createdPaths = prepareTargetPaths(targetSkillPath, workspacePath, shouldScaffold);

				if (shouldScaffold) {
					const createdSkillMd = writeStarterSkillFile(targetSkillPath);
					if (createdSkillMd) {
						createdPaths.push(createdSkillMd);
					}

					const createdEvals = writeStarterEvalsFile(targetSkillPath);
					if (createdEvals) {
						createdPaths.push(createdEvals);
					}
				}
			} catch (error) {
				ctx.ui.notify(`Failed to initialize skill workspace: ${(error as Error).message}`, "error");
				return;
			}

			persistState(
				{
					...state,
					targetSkillPath,
					workspacePath,
					preferredBaselineMode: state.preferredBaselineMode ?? "without-skill",
				},
				ctx,
			);

			const summary = [
				"Skill Creator target updated",
				`skill path: ${targetSkillPath}`,
				`workspace path: ${workspacePath}`,
				shouldScaffold
					? `scaffolded paths: ${createdPaths.length > 0 ? createdPaths.join(", ") : "nothing new created"}`
					: "scaffolded paths: not requested",
			].join("\n");
			ctx.ui.notify(summary, "info");
		},
	});

	pi.registerTool({
		name: "skill_creator_set_target",
		label: "Skill Creator Set Target",
		description: "Set or update the active skill-creator target skill path and workspace path.",
		promptSnippet: "Set the active skill-creator target skill and workspace paths",
		promptGuidelines: [
			"Use skill_creator_set_target before other skill-creator workflow tools when no target skill is configured.",
		],
		parameters: Type.Object({
			skillPath: Type.String({ description: "Path to the target skill directory" }),
			workspacePath: Type.Optional(Type.String({ description: "Path to the workspace directory" })),
			createMissingDirs: Type.Optional(
				Type.Boolean({ description: "Create missing skill, references, and workspace directories" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			const targetSkillPath = resolveUserPath(params.skillPath, ctx.cwd);
			if (existsSync(targetSkillPath) && !statSync(targetSkillPath).isDirectory()) {
				throw new Error(`Skill path exists but is not a directory: ${targetSkillPath}`);
			}

			const workspacePath = params.workspacePath
				? resolveUserPath(params.workspacePath, ctx.cwd)
				: defaultWorkspacePath(targetSkillPath, state);
			const createMissingDirs = params.createMissingDirs ?? false;

			const createdPaths = prepareTargetPaths(targetSkillPath, workspacePath, createMissingDirs);

			persistState(
				{
					...state,
					targetSkillPath,
					workspacePath,
					preferredBaselineMode: state.preferredBaselineMode ?? "without-skill",
				},
				ctx,
			);

			const lines = [
				"Skill Creator target updated.",
				`skill path: ${targetSkillPath}`,
				`workspace path: ${workspacePath}`,
				createMissingDirs
					? `created paths: ${createdPaths.length > 0 ? createdPaths.join(", ") : "nothing new created"}`
					: "created paths: not requested",
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					targetSkillPath,
					workspacePath,
					createdPaths,
					createMissingDirs,
				},
			};
		},
	});

	pi.registerTool({
		name: "skill_creator_scaffold_skill",
		label: "Skill Creator Scaffold Skill",
		description: "Scaffold standard skill directories and starter files for a target skill.",
		promptSnippet: "Scaffold a target skill directory with starter files and optional evals, scripts, and assets",
		promptGuidelines: [
			"Use skill_creator_scaffold_skill after choosing a skill path when the user wants starter skill files or directories created.",
		],
		parameters: Type.Object({
			skillPath: Type.String({ description: "Path to the target skill directory" }),
			includeEvals: Type.Optional(Type.Boolean({ description: "Create evals/evals.json starter content" })),
			includeScripts: Type.Optional(Type.Boolean({ description: "Create a scripts/ directory" })),
			includeAssets: Type.Optional(Type.Boolean({ description: "Create an assets/ directory" })),
			overwrite: Type.Optional(Type.Boolean({ description: "Overwrite starter files if they already exist" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const skillPath = resolveUserPath(params.skillPath, ctx.cwd);
			const includeEvals = params.includeEvals ?? true;
			const includeScripts = params.includeScripts ?? false;
			const includeAssets = params.includeAssets ?? false;
			const overwrite = params.overwrite ?? false;

			const createdPaths: string[] = [];
			const skippedPaths: string[] = [];

			const trackDirectory = (path: string, label: string) => {
				const created = createDirectoryIfMissing(path, label);
				if (created) {
					createdPaths.push(created);
				} else {
					skippedPaths.push(path);
				}
			};

			trackDirectory(skillPath, "Skill directory");
			trackDirectory(join(skillPath, "references"), "References directory");

			if (includeScripts) {
				trackDirectory(join(skillPath, "scripts"), "Scripts directory");
			}

			if (includeAssets) {
				trackDirectory(join(skillPath, "assets"), "Assets directory");
			}

			const starterSkillPath = writeStarterSkillFile(skillPath, overwrite);
			if (starterSkillPath) {
				createdPaths.push(starterSkillPath);
			} else {
				skippedPaths.push(join(skillPath, "SKILL.md"));
			}

			if (includeEvals) {
				const starterEvalsPath = writeStarterEvalsFile(skillPath, overwrite);
				if (starterEvalsPath) {
					createdPaths.push(starterEvalsPath);
				} else {
					skippedPaths.push(join(skillPath, "evals", "evals.json"));
				}
			}

			const lines = [
				"Skill scaffold complete.",
				`skill path: ${skillPath}`,
				`created: ${createdPaths.length > 0 ? createdPaths.join(", ") : "nothing new created"}`,
				`skipped: ${skippedPaths.length > 0 ? skippedPaths.join(", ") : "nothing skipped"}`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					skillPath,
					includeEvals,
					includeScripts,
					includeAssets,
					overwrite,
					createdPaths,
					skippedPaths,
				},
			};
		},
	});

	pi.registerTool({
		name: "skill_creator_validate_skill",
		label: "Skill Creator Validate Skill",
		description: "Validate a skill directory for required files and basic SKILL.md frontmatter.",
		promptSnippet: "Validate a target skill directory and report errors and warnings",
		promptGuidelines: [
			"Use skill_creator_validate_skill after scaffolding or editing a skill to catch missing SKILL.md files or invalid frontmatter.",
		],
		parameters: Type.Object({
			skillPath: Type.Optional(Type.String({ description: "Path to the target skill directory. Uses the active target if omitted." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			const rawSkillPath = params.skillPath ?? state.targetSkillPath;
			if (!rawSkillPath) {
				throw new Error("No skill path provided and no active target is set. Use skill_creator_set_target or /skill-init first.");
			}

			const skillPath = resolveUserPath(rawSkillPath, ctx.cwd);
			const result = validateSkillPath(skillPath);
			const summary = buildValidationSummary(skillPath, result);

			return {
				content: [{ type: "text", text: summary.text }],
				details: {
					skillPath,
					valid: result.valid,
					issues: result.issues,
					errorCount: summary.errorCount,
					warningCount: summary.warningCount,
				},
			};
		},
	});

	pi.registerTool({
		name: "skill_creator_set_snapshot",
		label: "Skill Creator Set Snapshot",
		description: "Set or clear the snapshot skill path used for snapshot-baseline evals.",
		promptSnippet: "Configure or clear the snapshot skill path for snapshot-baseline evaluation",
		promptGuidelines: [
			"Use skill_creator_set_snapshot when the user wants to compare iterations against a known-good published version of the skill, before running snapshot-baseline evals.",
		],
		parameters: Type.Object({
			snapshotPath: Type.Optional(
				Type.String({
					description:
						"Absolute or cwd-relative path to the snapshot skill directory. Omit or set clear=true to clear.",
				}),
			),
			clear: Type.Optional(
				Type.Boolean({ description: "If true, clears the persisted snapshot path." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			if (params.clear || (params.snapshotPath !== undefined && params.snapshotPath.trim() === "")) {
				persistState({ ...state, snapshotPath: undefined }, ctx);
				return {
					content: [{ type: "text", text: "Cleared snapshot path" }],
					details: { snapshotPath: null, cleared: true },
				};
			}

			if (!params.snapshotPath) {
				return {
					content: [
						{ type: "text", text: `Current snapshot path: ${state.snapshotPath ?? "not set"}` },
					],
					details: { snapshotPath: state.snapshotPath ?? null },
				};
			}

			const snapshotPath = resolveUserPath(params.snapshotPath, ctx.cwd);
			if (!existsSync(snapshotPath)) {
				throw new Error(`Snapshot path does not exist: ${snapshotPath}`);
			}
			if (!statSync(snapshotPath).isDirectory()) {
				throw new Error(`Snapshot path is not a directory: ${snapshotPath}`);
			}
			if (!existsSync(join(snapshotPath, "SKILL.md"))) {
				throw new Error(`Snapshot path does not contain SKILL.md: ${snapshotPath}`);
			}

			persistState({ ...state, snapshotPath }, ctx);
			return {
				content: [{ type: "text", text: `Set snapshot path to: ${snapshotPath}` }],
				details: { snapshotPath },
			};
		},
	});

	pi.registerTool({
		name: "skill_creator_optimize_description",
		label: "Skill Creator Optimize Description",
		description:
			"Run trigger-eval-driven optimization to improve a skill's description for better triggering accuracy.",
		promptSnippet:
			"Optimize the skill description with train/test trigger evals and return the best-by-test-score result",
		promptGuidelines: [
			"Use skill_creator_optimize_description after a skill has been drafted and a trigger eval set (queries with should_trigger booleans) exists, to improve the description's triggering precision and recall.",
		],
		parameters: Type.Object({
			skillPath: Type.Optional(
				Type.String({ description: "Target skill directory. Uses the active target if omitted." }),
			),
			workspacePath: Type.Optional(
				Type.String({ description: "Workspace directory. Uses the active workspace if omitted." }),
			),
			evalSetPath: Type.Optional(
				Type.String({
					description: "Trigger eval set JSON. Defaults to <skillPath>/evals/trigger-evals.json.",
				}),
			),
			iterations: Type.Optional(Type.Number({ description: "Optimization iterations. Default 5." })),
			trainSplit: Type.Optional(
				Type.Number({ description: "Train/test split fraction (0..1). Default 0.6." }),
			),
			seed: Type.Optional(Type.Number({ description: "Deterministic shuffle seed. Default 1." })),
			runsPerQuery: Type.Optional(
				Type.Number({ description: "Runs per query (stochastic averaging). Default 3." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			const skillPath = params.skillPath
				? resolveUserPath(params.skillPath, ctx.cwd)
				: state.targetSkillPath;
			if (!skillPath) {
				throw new Error(
					"No active target skill is set. Use /skill-init or skill_creator_set_target first.",
				);
			}

			const workspacePath = params.workspacePath
				? resolveUserPath(params.workspacePath, ctx.cwd)
				: state.workspacePath ?? defaultWorkspacePath(skillPath, state);
			const evalSetPath = params.evalSetPath
				? resolveUserPath(params.evalSetPath, ctx.cwd)
				: join(skillPath, "evals", "trigger-evals.json");
			const scriptPath = getOptimizeDescriptionScriptPath(skillPath);

			const issues: string[] = [];
			if (!existsSync(skillPath)) issues.push(`Skill path does not exist: ${skillPath}`);
			if (!existsSync(evalSetPath)) issues.push(`Trigger eval set is missing: ${evalSetPath}`);
			if (!existsSync(scriptPath)) issues.push(`SDK runner is missing: ${scriptPath}`);

			if (issues.length > 0) {
				return {
					content: [{ type: "text", text: issues.join("\n") }],
					details: { executed: false, success: false, reason: "invalid-setup", issues },
				};
			}

			const execArgs = [
				"--experimental-strip-types",
				scriptPath,
				"--skill-path",
				skillPath,
				"--workspace",
				workspacePath,
				"--eval-set",
				evalSetPath,
				"--cwd",
				inferProjectRootFromSkillPath(skillPath),
			];
			if (params.iterations !== undefined) execArgs.push("--iterations", String(params.iterations));
			if (params.trainSplit !== undefined) execArgs.push("--train-split", String(params.trainSplit));
			if (params.seed !== undefined) execArgs.push("--seed", String(params.seed));
			if (params.runsPerQuery !== undefined)
				execArgs.push("--runs-per-query", String(params.runsPerQuery));
			if (ctx.model) execArgs.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			const thinkingLevel = pi.getThinkingLevel();
			if (thinkingLevel) execArgs.push("--thinking", thinkingLevel);

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(skillPath)} optimize-description`);

			try {
				const result = await pi.exec("node", execArgs, {
					cwd: inferProjectRootFromSkillPath(skillPath),
					timeout: 3600_000,
					signal,
				});

				if (result.code === 0) {
					const runDirMatch = result.stdout?.match(/run dir:\s*(\S+)/);
					const lastOptimizationRunPath = runDirMatch ? runDirMatch[1] : undefined;
					persistState({ ...state, lastOptimizationRunPath }, ctx);
					return {
						content: [
							{
								type: "text",
								text: [
									"Description optimization completed.",
									result.stdout?.trim()
										? `stdout:\n${result.stdout.trim()}`
										: "stdout: (empty)",
								].join("\n\n"),
							},
						],
						details: {
							executed: true,
							success: true,
							skillPath,
							workspacePath,
							evalSetPath,
							lastOptimizationRunPath: lastOptimizationRunPath ?? null,
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.code,
						},
					};
				}

				return {
					content: [
						{
							type: "text",
							text: [
								"Description optimization failed.",
								result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
								result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
							]
								.filter(Boolean)
								.join("\n\n"),
						},
					],
					details: {
						executed: true,
						success: false,
						reason: "exec-failed",
						skillPath,
						workspacePath,
						evalSetPath,
						stdout: result.stdout,
						stderr: result.stderr,
						code: result.code,
						killed: result.killed,
					},
				};
			} catch (error) {
				throw new Error(
					`Failed to optimize description: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerTool({
		name: "skill_creator_run_evals",
		label: "Skill Creator Run Evals",
		description: "Run skill evals for a target skill using the SDK runner, or report why execution is blocked.",
		promptSnippet: "Run a skill eval iteration through the SDK runner and return the created artifacts or blocking issues",
		promptGuidelines: [
			"Use skill_creator_run_evals when the user wants to execute skill evals and you need to validate the target skill, workspace, eval set, and SDK runner path.",
		],
		parameters: Type.Object({
			skillPath: Type.Optional(Type.String({ description: "Path to the target skill directory. Uses the active target if omitted." })),
			workspacePath: Type.Optional(Type.String({ description: "Path to the workspace directory. Uses the active workspace if omitted." })),
			iteration: Type.Optional(Type.Number({ description: "Iteration number to run. Defaults to lastIteration + 1." })),
			baselineMode: Type.Optional(
				Type.String({ description: "Baseline mode: without-skill, none, or snapshot. Defaults to the preferred baseline mode." }),
			),
			snapshotPath: Type.Optional(
				Type.String({ description: "Path to the snapshot skill directory for snapshot baseline mode. Falls back to the persisted snapshot path." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			const iteration = params.iteration ?? (state.lastIteration ?? 0) + 1;
			const preferredBaseline = state.preferredBaselineMode ?? "without-skill";
			const baselineMode = resolveBaselineMode(params.baselineMode, preferredBaseline);

			let plan: RunEvalsPlan;
			try {
				plan = buildRunEvalsPlan(state, {
					skillPath: params.skillPath ? resolveUserPath(params.skillPath, ctx.cwd) : undefined,
					workspacePath: params.workspacePath ? resolveUserPath(params.workspacePath, ctx.cwd) : undefined,
					iteration,
					baselineMode,
					snapshotPath: params.snapshotPath ? resolveUserPath(params.snapshotPath, ctx.cwd) : undefined,
				});
			} catch (error) {
				throw new Error(`Failed to prepare eval run plan: ${(error as Error).message}`);
			}

			if (plan.issues.length > 0) {
				persistState({ ...state, preferredBaselineMode: baselineMode }, ctx);
				return {
					content: [{ type: "text", text: buildRunEvalsSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "invalid-plan",
						skillPath: plan.skillPath,
						workspacePath: plan.workspacePath,
						evalsPath: plan.evalsPath,
						iteration: plan.iteration,
						baselineMode: plan.baselineMode,
						scriptPath: plan.scriptPath,
						scriptExists: plan.scriptExists,
						issues: plan.issues,
						warnings: plan.warnings,
					},
				};
			}

			if (!plan.scriptExists) {
				persistState({ ...state, preferredBaselineMode: baselineMode }, ctx);
				return {
					content: [{ type: "text", text: buildRunEvalsSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "missing-runner",
						skillPath: plan.skillPath,
						workspacePath: plan.workspacePath,
						evalsPath: plan.evalsPath,
						iteration: plan.iteration,
						baselineMode: plan.baselineMode,
						scriptPath: plan.scriptPath,
						scriptExists: plan.scriptExists,
						issues: plan.issues,
						warnings: plan.warnings,
					},
				};
			}

			const thinkingLevel = pi.getThinkingLevel();
			const execArgs = buildRunEvalsExecArgs(plan, ctx, thinkingLevel);
			const iterationPath = join(plan.workspacePath, `iteration-${plan.iteration}`);

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} run-evals`);

			try {
				const result = await pi.exec("node", execArgs, {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
					signal,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							preferredBaselineMode: baselineMode,
							lastIteration: plan.iteration,
							lastIterationPath: iterationPath,
							snapshotPath: plan.snapshotPath ?? state.snapshotPath,
						},
						ctx,
					);

					return {
						content: [
							{
								type: "text",
								text: [
									"Eval run completed.",
									`iteration path: ${iterationPath}`,
									result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
								].join("\n\n"),
							},
						],
						details: {
							executed: true,
							success: true,
							skillPath: plan.skillPath,
							workspacePath: plan.workspacePath,
							iterationPath,
							evalsPath: plan.evalsPath,
							iteration: plan.iteration,
							baselineMode: plan.baselineMode,
							scriptPath: plan.scriptPath,
							scriptExists: plan.scriptExists,
							issues: plan.issues,
							warnings: plan.warnings,
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.code,
							killed: result.killed,
						},
					};
				}

				persistState({ ...state, preferredBaselineMode: baselineMode }, ctx);
				return {
					content: [
						{
							type: "text",
							text: [
								"Eval run failed.",
								buildRunEvalsSummary(plan),
								result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
								result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
							]
								.filter(Boolean)
								.join("\n\n"),
						},
					],
					details: {
						executed: true,
						success: false,
						reason: "exec-failed",
						skillPath: plan.skillPath,
						workspacePath: plan.workspacePath,
						iterationPath,
						evalsPath: plan.evalsPath,
						iteration: plan.iteration,
						baselineMode: plan.baselineMode,
						scriptPath: plan.scriptPath,
						scriptExists: plan.scriptExists,
						issues: plan.issues,
						warnings: plan.warnings,
						stdout: result.stdout,
						stderr: result.stderr,
						code: result.code,
						killed: result.killed,
					},
				};
			} catch (error) {
				persistState({ ...state, preferredBaselineMode: baselineMode }, ctx);
				throw new Error(`Failed to run evals: ${(error as Error).message}`);
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerTool({
		name: "skill_creator_grade_iteration",
		label: "Skill Creator Grade Iteration",
		description: "Grade a completed iteration against eval expectations, or report why grading is blocked.",
		promptSnippet: "Grade a completed iteration and write grading.json plus grading-summary.json artifacts",
		promptGuidelines: [
			"Use skill_creator_grade_iteration when the user wants expectation-based grading artifacts for a completed eval iteration.",
		],
		parameters: Type.Object({
			skillPath: Type.Optional(Type.String({ description: "Path to the target skill directory. Uses the active target if omitted." })),
			iterationPath: Type.Optional(Type.String({ description: "Path to the completed iteration directory. Uses the latest known iteration if omitted." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			let plan: GradePlan;
			try {
				plan = buildGradePlan(state, {
					skillPath: params.skillPath ? resolveUserPath(params.skillPath, ctx.cwd) : undefined,
					iterationPath: params.iterationPath ? resolveUserPath(params.iterationPath, ctx.cwd) : undefined,
				});
			} catch (error) {
				throw new Error(`Failed to prepare grading plan: ${(error as Error).message}`);
			}

			if (plan.issues.length > 0) {
				return {
					content: [{ type: "text", text: buildGradeSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "invalid-plan",
						...plan,
					},
				};
			}

			if (!plan.scriptExists) {
				return {
					content: [{ type: "text", text: buildGradeSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "missing-runner",
						...plan,
					},
				};
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} grade`);

			try {
				const result = await pi.exec("node", buildGradeExecArgs(plan), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
					signal,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastGradingPath: plan.summaryPath,
						},
						ctx,
					);
					return {
						content: [
							{
								type: "text",
								text: [
									"Iteration grading completed.",
									`grading summary: ${plan.summaryPath}`,
									result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
								].join("\n\n"),
							},
						],
						details: {
							executed: true,
							success: true,
							...plan,
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.code,
							killed: result.killed,
						},
					};
				}

				return {
					content: [
						{
							type: "text",
							text: [
								"Iteration grading failed.",
								buildGradeSummary(plan),
								result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
								result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
							]
								.filter(Boolean)
								.join("\n\n"),
						},
					],
					details: {
						executed: true,
						success: false,
						reason: "exec-failed",
						...plan,
						stdout: result.stdout,
						stderr: result.stderr,
						code: result.code,
						killed: result.killed,
					},
				};
			} catch (error) {
				throw new Error(`Failed to grade iteration: ${(error as Error).message}`);
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerTool({
		name: "skill_creator_compare_iteration",
		label: "Skill Creator Compare Iteration",
		description: "Run blind model-based comparisons for a completed iteration, optionally against a previous iteration, or report why comparison is blocked.",
		promptSnippet: "Compare completed iteration outputs blindly and write blind-comparison artifacts",
		promptGuidelines: [
			"Use skill_creator_compare_iteration when the user wants model-based blind comparisons across iteration configurations or against a previous iteration.",
		],
		parameters: Type.Object({
			skillPath: Type.Optional(Type.String({ description: "Path to the target skill directory. Uses the active target if omitted." })),
			iterationPath: Type.Optional(Type.String({ description: "Path to the completed iteration directory. Uses the latest known iteration if omitted." })),
			previousIterationPath: Type.Optional(Type.String({ description: "Optional previous iteration path for cross-iteration blind comparison." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			let plan: ComparePlan;
			try {
				plan = buildComparePlan(state, {
					skillPath: params.skillPath ? resolveUserPath(params.skillPath, ctx.cwd) : undefined,
					iterationPath: params.iterationPath ? resolveUserPath(params.iterationPath, ctx.cwd) : undefined,
					previousIterationPath: params.previousIterationPath
						? resolveUserPath(params.previousIterationPath, ctx.cwd)
						: undefined,
				});
			} catch (error) {
				throw new Error(`Failed to prepare blind-comparison plan: ${(error as Error).message}`);
			}

			if (plan.issues.length > 0) {
				return {
					content: [{ type: "text", text: buildCompareSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "invalid-plan",
						...plan,
					},
				};
			}

			if (!plan.scriptExists) {
				return {
					content: [{ type: "text", text: buildCompareSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "missing-runner",
						...plan,
					},
				};
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} compare`);

			try {
				const thinkingLevel = pi.getThinkingLevel();
				const result = await pi.exec("node", buildCompareExecArgs(plan, ctx, thinkingLevel), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
					signal,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastBlindComparisonPath: plan.summaryPath,
							lastBlindComparisonVsPreviousPath:
								plan.previousIterationPath && plan.previousIterationPath !== plan.iterationPath && existsSync(plan.previousIterationPath) && plan.previousSummaryPath
									? plan.previousSummaryPath
									: state.lastBlindComparisonVsPreviousPath,
						},
						ctx,
					);
					return {
						content: [
							{
								type: "text",
								text: [
									"Blind comparison completed.",
									`comparison summary: ${plan.summaryPath}`,
									plan.previousIterationPath && plan.previousIterationPath !== plan.iterationPath && existsSync(plan.previousIterationPath) && plan.previousSummaryPath
										? `comparison vs previous summary: ${plan.previousSummaryPath}`
										: undefined,
									result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
								].filter(Boolean).join("\n\n"),
							},
						],
						details: {
							executed: true,
							success: true,
							...plan,
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.code,
							killed: result.killed,
						},
					};
				}

				return {
					content: [
						{
							type: "text",
							text: [
								"Blind comparison failed.",
								buildCompareSummary(plan),
								result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
								result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
							]
								.filter(Boolean)
								.join("\n\n"),
						},
					],
					details: {
						executed: true,
						success: false,
						reason: "exec-failed",
						...plan,
						stdout: result.stdout,
						stderr: result.stderr,
						code: result.code,
						killed: result.killed,
					},
				};
			} catch (error) {
				throw new Error(`Failed to run blind comparison: ${(error as Error).message}`);
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerTool({
		name: "skill_creator_aggregate_benchmark",
		label: "Skill Creator Aggregate Benchmark",
		description: "Aggregate a completed iteration into benchmark artifacts, or report why aggregation is blocked.",
		promptSnippet: "Aggregate an iteration into benchmark.json and benchmark.md artifacts",
		promptGuidelines: [
			"Use skill_creator_aggregate_benchmark when the user wants a machine-readable benchmark summary for a completed eval iteration.",
		],
		parameters: Type.Object({
			skillPath: Type.Optional(Type.String({ description: "Path to the target skill directory. Uses the active target if omitted." })),
			iterationPath: Type.Optional(Type.String({ description: "Path to the completed iteration directory. Uses the latest known iteration if omitted." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			let plan: BenchmarkPlan;
			try {
				plan = buildBenchmarkPlan(state, {
					skillPath: params.skillPath ? resolveUserPath(params.skillPath, ctx.cwd) : undefined,
					iterationPath: params.iterationPath ? resolveUserPath(params.iterationPath, ctx.cwd) : undefined,
				});
			} catch (error) {
				throw new Error(`Failed to prepare benchmark plan: ${(error as Error).message}`);
			}

			if (plan.issues.length > 0) {
				return {
					content: [{ type: "text", text: buildBenchmarkSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "invalid-plan",
						...plan,
					},
				};
			}

			if (!plan.scriptExists) {
				return {
					content: [{ type: "text", text: buildBenchmarkSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "missing-runner",
						...plan,
					},
				};
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} benchmark`);

			try {
				const result = await pi.exec("node", buildBenchmarkExecArgs(plan), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
					signal,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastBenchmarkPath: plan.benchmarkJsonPath,
						},
						ctx,
					);
					return {
						content: [
							{
								type: "text",
								text: [
									"Benchmark aggregation completed.",
									`benchmark json: ${plan.benchmarkJsonPath}`,
									`benchmark md: ${plan.benchmarkMdPath}`,
									result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
								].join("\n\n"),
							},
						],
						details: {
							executed: true,
							success: true,
							...plan,
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.code,
							killed: result.killed,
						},
					};
				}

				return {
					content: [
						{
							type: "text",
							text: [
								"Benchmark aggregation failed.",
								buildBenchmarkSummary(plan),
								result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
								result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
							]
								.filter(Boolean)
								.join("\n\n"),
						},
					],
					details: {
						executed: true,
						success: false,
						reason: "exec-failed",
						...plan,
						stdout: result.stdout,
						stderr: result.stderr,
						code: result.code,
						killed: result.killed,
					},
				};
			} catch (error) {
				throw new Error(`Failed to aggregate benchmark: ${(error as Error).message}`);
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerTool({
		name: "skill_creator_generate_review",
		label: "Skill Creator Generate Review",
		description: "Generate a static review artifact for an iteration, or report why review generation is blocked.",
		promptSnippet: "Generate a static review.html artifact for a completed iteration",
		promptGuidelines: [
			"Use skill_creator_generate_review when the user wants an easier artifact for inspecting eval prompts, outputs, and transcripts.",
		],
		parameters: Type.Object({
			skillPath: Type.Optional(Type.String({ description: "Path to the target skill directory. Uses the active target if omitted." })),
			iterationPath: Type.Optional(Type.String({ description: "Path to the completed iteration directory. Uses the latest known iteration if omitted." })),
			benchmarkPath: Type.Optional(Type.String({ description: "Optional benchmark.json path to include in the review." })),
			previousIterationPath: Type.Optional(Type.String({ description: "Optional previous iteration path to surface cross-iteration comparison artifacts in the review." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			applyRestoredState(ctx);

			let plan: ReviewPlan;
			try {
				plan = buildReviewPlan(state, {
					skillPath: params.skillPath ? resolveUserPath(params.skillPath, ctx.cwd) : undefined,
					iterationPath: params.iterationPath ? resolveUserPath(params.iterationPath, ctx.cwd) : undefined,
					benchmarkPath: params.benchmarkPath ? resolveUserPath(params.benchmarkPath, ctx.cwd) : undefined,
					previousIterationPath: params.previousIterationPath
						? resolveUserPath(params.previousIterationPath, ctx.cwd)
						: undefined,
				});
			} catch (error) {
				throw new Error(`Failed to prepare review plan: ${(error as Error).message}`);
			}

			if (plan.issues.length > 0) {
				return {
					content: [{ type: "text", text: buildReviewSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "invalid-plan",
						...plan,
					},
				};
			}

			if (!plan.scriptExists) {
				return {
					content: [{ type: "text", text: buildReviewSummary(plan) }],
					details: {
						executed: false,
						success: false,
						reason: "missing-runner",
						...plan,
					},
				};
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} review`);

			try {
				const result = await pi.exec("node", buildReviewExecArgs(plan), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
					signal,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastBenchmarkPath: plan.benchmarkPath ?? state.lastBenchmarkPath,
							lastReviewArtifactPath: plan.reviewPath,
						},
						ctx,
					);
					return {
						content: [
							{
								type: "text",
								text: [
									"Review generation completed.",
									`review html: ${plan.reviewPath}`,
									result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
								].join("\n\n"),
							},
						],
						details: {
							executed: true,
							success: true,
							...plan,
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.code,
							killed: result.killed,
						},
					};
				}

				return {
					content: [
						{
							type: "text",
							text: [
								"Review generation failed.",
								buildReviewSummary(plan),
								result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
								result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
							]
								.filter(Boolean)
								.join("\n\n"),
						},
					],
					details: {
						executed: true,
						success: false,
						reason: "exec-failed",
						...plan,
						stdout: result.stdout,
						stderr: result.stderr,
						code: result.code,
						killed: result.killed,
					},
				};
			} catch (error) {
				throw new Error(`Failed to generate review: ${(error as Error).message}`);
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerCommand("skill-set-snapshot", {
		description: "Set or clear the snapshot skill path used for snapshot-baseline evals",
		handler: async (args, ctx) => {
			applyRestoredState(ctx);
			const rawArg = args.trim();
			const input =
				rawArg ||
				(await ctx.ui.input(
					"Snapshot skill path (leave blank to clear):",
					state.snapshotPath ?? "",
				));

			if (input === undefined || input.trim() === "") {
				persistState({ ...state, snapshotPath: undefined }, ctx);
				ctx.ui.notify("Cleared snapshot path", "info");
				return;
			}

			const snapshotPath = resolveUserPath(input, ctx.cwd);
			if (!existsSync(snapshotPath)) {
				ctx.ui.notify(`Snapshot path does not exist: ${snapshotPath}`, "error");
				return;
			}
			if (!statSync(snapshotPath).isDirectory()) {
				ctx.ui.notify(`Snapshot path is not a directory: ${snapshotPath}`, "error");
				return;
			}
			if (!existsSync(join(snapshotPath, "SKILL.md"))) {
				ctx.ui.notify(`Snapshot path does not contain SKILL.md: ${snapshotPath}`, "error");
				return;
			}

			persistState({ ...state, snapshotPath }, ctx);
			ctx.ui.notify(`Set snapshot path to: ${snapshotPath}`, "info");
		},
	});

	pi.registerCommand("skill-validate", {
		description: "Validate the current or specified skill directory",
		handler: async (args, ctx) => {
			applyRestoredState(ctx);

			const rawArg = args.trim();
			const rawSkillPath = rawArg || state.targetSkillPath;
			if (!rawSkillPath) {
				ctx.ui.notify("No skill path provided and no active target is set. Use /skill-init first.", "error");
				return;
			}

			const skillPath = resolveUserPath(rawSkillPath, ctx.cwd);
			const result = validateSkillPath(skillPath);
			const summary = buildValidationSummary(skillPath, result);
			ctx.ui.notify(summary.text, result.valid ? "info" : "warning");
		},
	});

	pi.registerCommand("skill-run-evals", {
		description: "Run evals for the current target skill using the SDK runner",
		handler: async (_args, ctx) => {
			applyRestoredState(ctx);

			if (!state.targetSkillPath) {
				ctx.ui.notify("No active target skill is set. Use /skill-init first.", "error");
				return;
			}

			const defaultIteration = String((state.lastIteration ?? 0) + 1);
			const iterationInput = await ctx.ui.input("Iteration number:", defaultIteration);
			if (!iterationInput?.trim()) {
				ctx.ui.notify("Cancelled eval run", "warning");
				return;
			}

			const iteration = Number.parseInt(iterationInput.trim(), 10);
			if (!Number.isInteger(iteration) || iteration < 1) {
				ctx.ui.notify(`Invalid iteration number: ${iterationInput}`, "error");
				return;
			}

			const preferredBaseline = state.preferredBaselineMode ?? "without-skill";
			const baselineSelection = await ctx.ui.select("Baseline mode:", orderedBaselineModes(preferredBaseline));
			if (!baselineSelection) {
				ctx.ui.notify("Cancelled eval run", "warning");
				return;
			}

			const baselineMode = resolveBaselineMode(baselineSelection, preferredBaseline);

			let snapshotPath: string | undefined = state.snapshotPath;
			if (baselineMode === "snapshot" && !snapshotPath) {
				const snapshotInput = await ctx.ui.input("Snapshot skill path:", "");
				if (!snapshotInput?.trim()) {
					ctx.ui.notify("Cancelled eval run", "warning");
					return;
				}
				snapshotPath = resolveUserPath(snapshotInput, ctx.cwd);
			}

			let plan: RunEvalsPlan;
			try {
				plan = buildRunEvalsPlan(state, {
					iteration,
					baselineMode,
					snapshotPath,
				});
			} catch (error) {
				ctx.ui.notify(`Failed to prepare eval run plan: ${(error as Error).message}`, "error");
				return;
			}

			if (plan.issues.length > 0) {
				ctx.ui.notify(buildRunEvalsSummary(plan), "warning");
				return;
			}

			if (!plan.scriptExists) {
				ctx.ui.notify(buildRunEvalsSummary(plan), "warning");
				return;
			}

			const thinkingLevel = pi.getThinkingLevel();
			const execArgs = buildRunEvalsExecArgs(plan, ctx, thinkingLevel);
			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} run-evals`);

			try {
				const result = await pi.exec("node", execArgs, {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
				});
				const iterationPath = join(plan.workspacePath, `iteration-${plan.iteration}`);

				if (result.code === 0) {
					persistState(
						{
							...state,
							preferredBaselineMode: baselineMode,
							lastIteration: plan.iteration,
							lastIterationPath: iterationPath,
							snapshotPath: plan.snapshotPath ?? state.snapshotPath,
						},
						ctx,
					);
					ctx.ui.notify(
						[
							"Eval run completed.",
							`iteration path: ${iterationPath}`,
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
						].join("\n\n"),
						"info",
					);
				} else {
					persistState({ ...state, preferredBaselineMode: baselineMode }, ctx);
					ctx.ui.notify(
						[
							"Eval run failed.",
							buildRunEvalsSummary(plan),
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
							result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
						]
							.filter(Boolean)
							.join("\n\n"),
						"error",
					);
				}
			} catch (error) {
				persistState({ ...state, preferredBaselineMode: baselineMode }, ctx);
				ctx.ui.notify(`Failed to run evals: ${(error as Error).message}`, "error");
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerCommand("skill-grade", {
		description: "Grade a completed iteration against eval expectations",
		handler: async (_args, ctx) => {
			applyRestoredState(ctx);

			if (!state.targetSkillPath) {
				ctx.ui.notify("No active target skill is set. Use /skill-init first.", "error");
				return;
			}

			const iterationInput = await ctx.ui.input("Iteration path:", defaultIterationPath(state));
			if (!iterationInput?.trim()) {
				ctx.ui.notify("Cancelled iteration grading", "warning");
				return;
			}

			let plan: GradePlan;
			try {
				plan = buildGradePlan(state, {
					iterationPath: resolveUserPath(iterationInput, ctx.cwd),
				});
			} catch (error) {
				ctx.ui.notify(`Failed to prepare grading plan: ${(error as Error).message}`, "error");
				return;
			}

			if (plan.issues.length > 0 || !plan.scriptExists) {
				ctx.ui.notify(buildGradeSummary(plan), "warning");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} grade`);
			try {
				const result = await pi.exec("node", buildGradeExecArgs(plan), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastGradingPath: plan.summaryPath,
						},
						ctx,
					);
					ctx.ui.notify(
						[
							"Iteration grading completed.",
							`grading summary: ${plan.summaryPath}`,
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
						].join("\n\n"),
						"info",
					);
				} else {
					ctx.ui.notify(
						[
							"Iteration grading failed.",
							buildGradeSummary(plan),
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
							result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
						]
							.filter(Boolean)
							.join("\n\n"),
						"error",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Failed to grade iteration: ${(error as Error).message}`, "error");
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerCommand("skill-compare", {
		description: "Run blind model-based comparisons for a completed iteration, optionally against a previous iteration",
		handler: async (_args, ctx) => {
			applyRestoredState(ctx);

			if (!state.targetSkillPath) {
				ctx.ui.notify("No active target skill is set. Use /skill-init first.", "error");
				return;
			}

			const iterationInput = await ctx.ui.input("Iteration path:", defaultIterationPath(state));
			if (!iterationInput?.trim()) {
				ctx.ui.notify("Cancelled blind comparison", "warning");
				return;
			}

			const resolvedIterationPath = resolveUserPath(iterationInput, ctx.cwd);
			const previousIterationInput = await ctx.ui.input(
				"Previous iteration path (optional):",
				guessPreviousIterationPath(resolvedIterationPath),
			);

			let plan: ComparePlan;
			try {
				plan = buildComparePlan(state, {
					iterationPath: resolvedIterationPath,
					previousIterationPath: previousIterationInput?.trim()
						? resolveUserPath(previousIterationInput, ctx.cwd)
						: undefined,
				});
			} catch (error) {
				ctx.ui.notify(`Failed to prepare blind-comparison plan: ${(error as Error).message}`, "error");
				return;
			}

			if (plan.issues.length > 0 || !plan.scriptExists) {
				ctx.ui.notify(buildCompareSummary(plan), "warning");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} compare`);
			try {
				const thinkingLevel = pi.getThinkingLevel();
				const result = await pi.exec("node", buildCompareExecArgs(plan, ctx, thinkingLevel), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastBlindComparisonPath: plan.summaryPath,
							lastBlindComparisonVsPreviousPath:
								plan.previousIterationPath && plan.previousIterationPath !== plan.iterationPath && existsSync(plan.previousIterationPath) && plan.previousSummaryPath
									? plan.previousSummaryPath
									: state.lastBlindComparisonVsPreviousPath,
						},
						ctx,
					);
					ctx.ui.notify(
						[
							"Blind comparison completed.",
							`comparison summary: ${plan.summaryPath}`,
							plan.previousIterationPath && plan.previousIterationPath !== plan.iterationPath && existsSync(plan.previousIterationPath) && plan.previousSummaryPath
								? `comparison vs previous summary: ${plan.previousSummaryPath}`
								: undefined,
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
						]
							.filter(Boolean)
							.join("\n\n"),
						"info",
					);
				} else {
					ctx.ui.notify(
						[
							"Blind comparison failed.",
							buildCompareSummary(plan),
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
							result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
						]
							.filter(Boolean)
							.join("\n\n"),
						"error",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Failed to run blind comparison: ${(error as Error).message}`, "error");
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerCommand("skill-benchmark", {
		description: "Aggregate a completed iteration into benchmark artifacts",
		handler: async (_args, ctx) => {
			applyRestoredState(ctx);

			if (!state.targetSkillPath) {
				ctx.ui.notify("No active target skill is set. Use /skill-init first.", "error");
				return;
			}

			const iterationInput = await ctx.ui.input("Iteration path:", defaultIterationPath(state));
			if (!iterationInput?.trim()) {
				ctx.ui.notify("Cancelled benchmark aggregation", "warning");
				return;
			}

			let plan: BenchmarkPlan;
			try {
				plan = buildBenchmarkPlan(state, {
					iterationPath: resolveUserPath(iterationInput, ctx.cwd),
				});
			} catch (error) {
				ctx.ui.notify(`Failed to prepare benchmark plan: ${(error as Error).message}`, "error");
				return;
			}

			if (plan.issues.length > 0 || !plan.scriptExists) {
				ctx.ui.notify(buildBenchmarkSummary(plan), "warning");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} benchmark`);
			try {
				const result = await pi.exec("node", buildBenchmarkExecArgs(plan), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastBenchmarkPath: plan.benchmarkJsonPath,
						},
						ctx,
					);
					ctx.ui.notify(
						[
							"Benchmark aggregation completed.",
							`benchmark json: ${plan.benchmarkJsonPath}`,
							`benchmark md: ${plan.benchmarkMdPath}`,
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
						].join("\n\n"),
						"info",
					);
				} else {
					ctx.ui.notify(
						[
							"Benchmark aggregation failed.",
							buildBenchmarkSummary(plan),
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
							result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
						]
							.filter(Boolean)
							.join("\n\n"),
						"error",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Failed to aggregate benchmark: ${(error as Error).message}`, "error");
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerCommand("skill-review", {
		description: "Generate a static review artifact for a completed iteration",
		handler: async (_args, ctx) => {
			applyRestoredState(ctx);

			if (!state.targetSkillPath) {
				ctx.ui.notify("No active target skill is set. Use /skill-init first.", "error");
				return;
			}

			const iterationInput = await ctx.ui.input("Iteration path:", defaultIterationPath(state));
			if (!iterationInput?.trim()) {
				ctx.ui.notify("Cancelled review generation", "warning");
				return;
			}

			let plan: ReviewPlan;
			try {
				plan = buildReviewPlan(state, {
					iterationPath: resolveUserPath(iterationInput, ctx.cwd),
				});
			} catch (error) {
				ctx.ui.notify(`Failed to prepare review plan: ${(error as Error).message}`, "error");
				return;
			}

			if (plan.issues.length > 0 || !plan.scriptExists) {
				ctx.ui.notify(buildReviewSummary(plan), "warning");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(plan.skillPath)} review`);
			try {
				const result = await pi.exec("node", buildReviewExecArgs(plan), {
					cwd: inferProjectRootFromSkillPath(plan.skillPath),
					timeout: 3600_000,
				});

				if (result.code === 0) {
					persistState(
						{
							...state,
							lastIterationPath: plan.iterationPath,
							lastBenchmarkPath: plan.benchmarkPath ?? state.lastBenchmarkPath,
							lastReviewArtifactPath: plan.reviewPath,
						},
						ctx,
					);
					ctx.ui.notify(
						[
							"Review generation completed.",
							`review html: ${plan.reviewPath}`,
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
						].join("\n\n"),
						"info",
					);
				} else {
					ctx.ui.notify(
						[
							"Review generation failed.",
							buildReviewSummary(plan),
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
							result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
						]
							.filter(Boolean)
							.join("\n\n"),
						"error",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Failed to generate review: ${(error as Error).message}`, "error");
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerCommand("skill-optimize-description", {
		description: "Optimize the skill's description for better trigger accuracy via trigger evals",
		handler: async (_args, ctx) => {
			applyRestoredState(ctx);

			if (!state.targetSkillPath) {
				ctx.ui.notify("No active target skill is set. Use /skill-init first.", "error");
				return;
			}

			const skillPath = state.targetSkillPath;
			const workspacePath = state.workspacePath ?? defaultWorkspacePath(skillPath, state);
			const evalSetPath = join(skillPath, "evals", "trigger-evals.json");
			const scriptPath = getOptimizeDescriptionScriptPath(skillPath);

			if (!existsSync(skillPath)) {
				ctx.ui.notify(`Skill path does not exist: ${skillPath}`, "error");
				return;
			}
			if (!existsSync(evalSetPath)) {
				ctx.ui.notify(
					`Trigger eval set is missing: ${evalSetPath}\nCreate one as a JSON array of { query, should_trigger } entries.`,
					"error",
				);
				return;
			}
			if (!existsSync(scriptPath)) {
				ctx.ui.notify(`Expected SDK runner is missing: ${scriptPath}`, "error");
				return;
			}

			const iterationsInput = await ctx.ui.input("Iterations (default 5):", "5");
			const iterations = Number.parseInt((iterationsInput ?? "5").trim() || "5", 10);
			if (!Number.isInteger(iterations) || iterations < 0) {
				ctx.ui.notify(`Invalid iteration count: ${iterationsInput}`, "error");
				return;
			}

			const thinkingLevel = pi.getThinkingLevel();
			const args = [
				"--experimental-strip-types",
				scriptPath,
				"--skill-path",
				skillPath,
				"--workspace",
				workspacePath,
				"--eval-set",
				evalSetPath,
				"--iterations",
				String(iterations),
				"--cwd",
				inferProjectRootFromSkillPath(skillPath),
			];
			if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			if (thinkingLevel) args.push("--thinking", thinkingLevel);

			ctx.ui.setStatus(STATUS_KEY, `skill:${basename(skillPath)} optimize-description`);

			try {
				const result = await pi.exec("node", args, {
					cwd: inferProjectRootFromSkillPath(skillPath),
					timeout: 3600_000,
				});

				if (result.code === 0) {
					const runDirMatch = result.stdout?.match(/run dir:\s*(\S+)/);
					const lastOptimizationRunPath = runDirMatch ? runDirMatch[1] : undefined;
					persistState({ ...state, lastOptimizationRunPath }, ctx);
					ctx.ui.notify(
						[
							"Description optimization completed.",
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
						].join("\n\n"),
						"info",
					);
				} else {
					ctx.ui.notify(
						[
							"Description optimization failed.",
							result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
							result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
						]
							.filter(Boolean)
							.join("\n\n"),
						"error",
					);
				}
			} catch (error) {
				ctx.ui.notify(
					`Failed to optimize description: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				updateStatus(ctx, state);
			}
		},
	});

	pi.registerCommand("skill-status", {
		description: "Show the current skill-creator target and workspace state",
		handler: async (_args, ctx) => {
			applyRestoredState(ctx);
			ctx.ui.notify(buildStatusMessage(state), state.targetSkillPath ? "info" : "warning");
		},
	});
}
