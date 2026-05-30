#!/usr/bin/env -S node --experimental-strip-types

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PROMPT_EVALS_ROOT = path.resolve(REPO_ROOT, "evals", "prompts");

const DEFAULT_MODEL_ID = "gpt-4o-mini";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function parseOptionalString(value, label) {
	if (value === undefined) {
		return undefined;
	}
	return assertNonEmptyString(value, label);
}

function parseOptionalNumber(value, label) {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(`${label} must be a number`);
	}
	return value;
}

function parseOptionalPositiveInteger(value, label) {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be an integer >= 1`);
	}
	return value;
}

function parseMessages(value, label) {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	return value.map((message, index) => {
		if (!isRecord(message)) {
			throw new Error(`${label}[${index}] must be an object`);
		}
		const role = message.role;
		if (role !== "system" && role !== "user" && role !== "assistant") {
			throw new Error(`${label}[${index}].role must be \"system\", \"user\", or \"assistant\"`);
		}
		return {
			role,
			content: assertNonEmptyString(message.content, `${label}[${index}].content`),
		};
	});
}

function parsePattern(value, label) {
	if (typeof value === "string") {
		if (value.length === 0) {
			throw new Error(`${label} must not be empty`);
		}
		return value;
	}
	if (!isRecord(value)) {
		throw new Error(`${label} must be a string or { pattern, flags? } object`);
	}
	return {
		pattern: assertNonEmptyString(value.pattern, `${label}.pattern`),
		flags: parseOptionalString(value.flags, `${label}.flags`),
	};
}

function parsePatterns(value, label) {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	return value.map((entry, index) => parsePattern(entry, `${label}[${index}]`));
}

function parseStringArray(value, label) {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	return value.map((entry, index) => assertNonEmptyString(entry, `${label}[${index}]`));
}

function parseJsonPrimitiveRecord(value, label) {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`);
	}
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof key !== "string" || key.trim().length === 0) {
			throw new Error(`${label} keys must be non-empty strings`);
		}
		if (entry !== null && typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
			throw new Error(`${label}.${key} must be a string, number, boolean, or null`);
		}
		result[key] = entry;
	}
	return result;
}

function parseStringRecord(value, label) {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`);
	}
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = assertNonEmptyString(entry, `${label}.${key}`);
	}
	return result;
}

function parseAssertions(value, label) {
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`);
	}

	const json = value.json;
	let parsedJson;
	if (json !== undefined) {
		if (!isRecord(json)) {
			throw new Error(`${label}.json must be an object`);
		}
		parsedJson = {
			requiredPaths: parseStringArray(json.requiredPaths, `${label}.json.requiredPaths`),
			equals: parseJsonPrimitiveRecord(json.equals, `${label}.json.equals`),
			contains: parseStringRecord(json.contains, `${label}.json.contains`),
		};
	}

	const assertions = {
		equals: parseOptionalString(value.equals, `${label}.equals`),
		contains: parseStringArray(value.contains, `${label}.contains`),
		containsAny: parseStringArray(value.containsAny, `${label}.containsAny`),
		notContains: parseStringArray(value.notContains, `${label}.notContains`),
		regex: parsePatterns(value.regex, `${label}.regex`),
		notRegex: parsePatterns(value.notRegex, `${label}.notRegex`),
		json: parsedJson,
	};

	if (
		assertions.equals === undefined &&
		assertions.contains === undefined &&
		assertions.containsAny === undefined &&
		assertions.notContains === undefined &&
		assertions.regex === undefined &&
		assertions.notRegex === undefined &&
		assertions.json === undefined
	) {
		throw new Error(`${label} must define at least one assertion`);
	}

	return assertions;
}

function parseDefaults(value, label) {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`);
	}
	return {
		systemPrompt: parseOptionalString(value.systemPrompt, `${label}.systemPrompt`),
		messages: parseMessages(value.messages, `${label}.messages`),
		temperature: parseOptionalNumber(value.temperature, `${label}.temperature`),
		maxTokens: parseOptionalPositiveInteger(value.maxTokens, `${label}.maxTokens`),
		repeat: parseOptionalPositiveInteger(value.repeat, `${label}.repeat`),
		passThreshold: parseOptionalPositiveInteger(value.passThreshold, `${label}.passThreshold`),
		timeoutMs: parseOptionalPositiveInteger(value.timeoutMs, `${label}.timeoutMs`),
	};
}

function parseCase(value, label) {
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`);
	}
	return {
		id: assertNonEmptyString(value.id, `${label}.id`),
		description: parseOptionalString(value.description, `${label}.description`),
		prompt: parseOptionalString(value.prompt, `${label}.prompt`),
		assertions: parseAssertions(value.assertions, `${label}.assertions`),
		systemPrompt: parseOptionalString(value.systemPrompt, `${label}.systemPrompt`),
		messages: parseMessages(value.messages, `${label}.messages`),
		temperature: parseOptionalNumber(value.temperature, `${label}.temperature`),
		maxTokens: parseOptionalPositiveInteger(value.maxTokens, `${label}.maxTokens`),
		repeat: parseOptionalPositiveInteger(value.repeat, `${label}.repeat`),
		passThreshold: parseOptionalPositiveInteger(value.passThreshold, `${label}.passThreshold`),
		timeoutMs: parseOptionalPositiveInteger(value.timeoutMs, `${label}.timeoutMs`),
	};
}

function parseSuite(value, filePath, index) {
	const label = `${path.relative(REPO_ROOT, filePath)}${index > 0 ? `#${index + 1}` : ""}`;
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`);
	}
	const modelId = parseOptionalString(value.modelId, `${label}.modelId`) ?? DEFAULT_MODEL_ID;
	const defaults = parseDefaults(value.defaults, `${label}.defaults`);
	const rawCases = value.cases;
	if (!Array.isArray(rawCases) || rawCases.length === 0) {
		throw new Error(`${label}.cases must be a non-empty array`);
	}
	return {
		filePath,
		suiteId: assertNonEmptyString(value.suiteId, `${label}.suiteId`),
		description: parseOptionalString(value.description, `${label}.description`),
		modelId,
		defaults,
		cases: rawCases.map((entry, caseIndex) => parseCase(entry, `${label}.cases[${caseIndex}]`)),
	};
}

function walkPromptEvalFiles(rootDir) {
	if (!existsSync(rootDir)) {
		return [];
	}

	const filePaths = [];
	for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
		const fullPath = path.resolve(rootDir, entry.name);
		if (entry.isDirectory()) {
			filePaths.push(...walkPromptEvalFiles(fullPath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".eval.json")) {
			filePaths.push(fullPath);
		}
	}
	return filePaths.sort((a, b) => a.localeCompare(b));
}

function loadPromptEvalSuites(rootDir = PROMPT_EVALS_ROOT) {
	const filter = process.env.PROMPT_EVALS_FILTER?.trim().toLowerCase();
	const suites = walkPromptEvalFiles(rootDir).flatMap((filePath) => {
		const raw = JSON.parse(readFileSync(filePath, "utf8"));
		const suiteEntries = Array.isArray(raw) ? raw : [raw];
		return suiteEntries.map((entry, index) => parseSuite(entry, filePath, index));
	});

	if (!filter) {
		return suites;
	}

	return suites
		.map((suite) => {
			const suiteMatches = `${suite.suiteId} ${suite.description ?? ""}`.toLowerCase().includes(filter);
			const cases = suiteMatches
				? suite.cases
				: suite.cases.filter((evalCase) =>
						`${evalCase.id} ${evalCase.description ?? ""}`.toLowerCase().includes(filter),
				);
			return { ...suite, cases };
		})
		.filter((suite) => suite.cases.length > 0);
}

function normalizeText(text) {
	return text.replace(/\r\n/g, "\n").trim();
}

function resolveCaseConfig(suite, evalCase) {
	const messages = [...(suite.defaults.messages ?? []), ...(evalCase.messages ?? [])];
	if (evalCase.prompt) {
		messages.push({ role: "user", content: evalCase.prompt });
	}
	if (messages.length === 0) {
		throw new Error(`${suite.suiteId}/${evalCase.id} must define at least one message or prompt`);
	}

	const repeat = evalCase.repeat ?? suite.defaults.repeat ?? 1;
	const passThreshold = evalCase.passThreshold ?? suite.defaults.passThreshold ?? repeat;
	if (passThreshold > repeat) {
		throw new Error(`${suite.suiteId}/${evalCase.id} has passThreshold > repeat`);
	}

	return {
		systemPrompt: evalCase.systemPrompt ?? suite.defaults.systemPrompt,
		messages,
		temperature: evalCase.temperature ?? suite.defaults.temperature ?? DEFAULT_TEMPERATURE,
		maxTokens: evalCase.maxTokens ?? suite.defaults.maxTokens,
		repeat,
		passThreshold,
		timeoutMs: evalCase.timeoutMs ?? suite.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		assertions: evalCase.assertions,
	};
}

function lookupJsonPath(value, jsonPath) {
	if (jsonPath.length === 0) {
		return value;
	}

	let current = value;
	for (const segment of jsonPath.split(".")) {
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				return undefined;
			}
			current = current[index];
			continue;
		}
		if (!isRecord(current) || !(segment in current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function normalizePatternFlags(flags) {
	return flags?.includes("u") ? flags : `${flags ?? ""}u`;
}

function compilePattern(pattern) {
	if (typeof pattern === "string") {
		return new RegExp(pattern, "u");
	}
	return new RegExp(pattern.pattern, normalizePatternFlags(pattern.flags));
}

function formatPattern(pattern) {
	if (typeof pattern === "string") {
		return `/${pattern}/u`;
	}
	return `/${pattern.pattern}/${normalizePatternFlags(pattern.flags)}`;
}

function evaluateAssertions(result, assertions) {
	const failures = [];
	const normalizedResponseText = normalizeText(result.responseText);

	if (result.finishReason !== "stop") {
		failures.push(`Expected finish_reason \"stop\", received ${JSON.stringify(result.finishReason)}`);
	}

	if (assertions.equals !== undefined && normalizedResponseText !== normalizeText(assertions.equals)) {
		failures.push(`Expected exact response ${JSON.stringify(normalizeText(assertions.equals))}`);
	}

	for (const fragment of assertions.contains ?? []) {
		if (!normalizedResponseText.includes(fragment)) {
			failures.push(`Expected response to contain ${JSON.stringify(fragment)}`);
		}
	}

	if ((assertions.containsAny?.length ?? 0) > 0) {
		const matched = assertions.containsAny.some((fragment) => normalizedResponseText.includes(fragment));
		if (!matched) {
			failures.push(
				`Expected response to contain at least one of ${assertions.containsAny.map((entry) => JSON.stringify(entry)).join(", ")}`,
			);
		}
	}

	for (const fragment of assertions.notContains ?? []) {
		if (normalizedResponseText.includes(fragment)) {
			failures.push(`Expected response not to contain ${JSON.stringify(fragment)}`);
		}
	}

	for (const pattern of assertions.regex ?? []) {
		if (!compilePattern(pattern).test(normalizedResponseText)) {
			failures.push(`Expected response to match ${formatPattern(pattern)}`);
		}
	}

	for (const pattern of assertions.notRegex ?? []) {
		if (compilePattern(pattern).test(normalizedResponseText)) {
			failures.push(`Expected response not to match ${formatPattern(pattern)}`);
		}
	}

	if (assertions.json) {
		let parsedJson;
		try {
			parsedJson = JSON.parse(normalizedResponseText);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`Expected valid JSON response: ${message}`);
			return failures;
		}

		for (const jsonPath of assertions.json.requiredPaths ?? []) {
			if (lookupJsonPath(parsedJson, jsonPath) === undefined) {
				failures.push(`Expected JSON path ${JSON.stringify(jsonPath)} to be present`);
			}
		}

		for (const [jsonPath, expected] of Object.entries(assertions.json.equals ?? {})) {
			const actual = lookupJsonPath(parsedJson, jsonPath);
			if (actual !== expected) {
				failures.push(
					`Expected JSON path ${JSON.stringify(jsonPath)} to equal ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
				);
			}
		}

		for (const [jsonPath, fragment] of Object.entries(assertions.json.contains ?? {})) {
			const actual = lookupJsonPath(parsedJson, jsonPath);
			if (typeof actual !== "string") {
				failures.push(
					`Expected JSON path ${JSON.stringify(jsonPath)} to be a string containing ${JSON.stringify(fragment)}`,
				);
				continue;
			}
			if (!actual.includes(fragment)) {
				failures.push(`Expected JSON path ${JSON.stringify(jsonPath)} to contain ${JSON.stringify(fragment)}`);
			}
		}
	}

	return failures;
}

function formatAttemptResult(result) {
	const header = `Attempt ${result.attempt}: ${result.failures.length === 0 ? "PASS" : "FAIL"}`;
	const body = result.failures.length === 0 ? "" : `${result.failures.map((failure) => `- ${failure}`).join("\n")}\n`;
	return `${header}\nfinish_reason: ${result.finishReason ?? "<missing>"}\n${body}response:\n${result.responseText || "<empty>"}`;
}

function buildChatMessages(config) {
	const messages = [];
	if (config.systemPrompt) {
		messages.push({ role: "system", content: config.systemPrompt });
	}
	for (const message of config.messages) {
		messages.push({ role: message.role, content: message.content });
	}
	return messages;
}

function extractTextContent(content) {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			if (typeof part === "string") {
				return part;
			}
			if (!isRecord(part)) {
				return "";
			}
			if (typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.join("");
}

async function requestChatCompletion(modelId, config, apiKey) {
	const controller = new AbortController();
	const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);
	const baseUrl = (process.env.PROMPT_EVALS_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");

	const body = {
		model: modelId,
		messages: buildChatMessages(config),
		temperature: config.temperature,
	};
	if (config.maxTokens !== undefined) {
		body.max_tokens = config.maxTokens;
	}

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		const rawText = await response.text();
		let parsed;
		try {
			parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
		} catch (error) {
			if (!response.ok) {
				throw new Error(
					`OpenAI request failed (${response.status} ${response.statusText}): ${rawText || "<empty response body>"}`,
				);
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`OpenAI response was not valid JSON: ${message}`);
		}

		if (!response.ok) {
			const errorMessage = parsed?.error?.message || rawText || "Unknown error";
			throw new Error(`OpenAI request failed (${response.status} ${response.statusText}): ${errorMessage}`);
		}

		const choice = parsed?.choices?.[0];
		if (!choice || !isRecord(choice)) {
			throw new Error("OpenAI response did not include choices[0]");
		}

		return {
			finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
			responseText: extractTextContent(choice.message?.content),
			raw: parsed,
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`OpenAI request timed out after ${config.timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutHandle);
	}
}

async function assertPromptEvalCase(suite, evalCase, apiKey) {
	const trimmedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
	if (!trimmedApiKey) {
		throw new Error("OPENAI_API_KEY is required to run prompt evals");
	}

	const config = resolveCaseConfig(suite, evalCase);
	const attempts = [];

	for (let attempt = 1; attempt <= config.repeat; attempt++) {
		const result = await requestChatCompletion(suite.modelId, config, trimmedApiKey);
		attempts.push({
			attempt,
			finishReason: result.finishReason,
			responseText: result.responseText,
			failures: evaluateAssertions(result, config.assertions),
		});
	}

	const passingAttempts = attempts.filter((attempt) => attempt.failures.length === 0).length;
	if (passingAttempts >= config.passThreshold) {
		return;
	}

	throw new Error(
		[
			`Prompt eval failed for ${suite.suiteId}/${evalCase.id}`,
			`Expected ${config.passThreshold} passing attempt(s) out of ${config.repeat}, received ${passingAttempts}.`,
			...(evalCase.description ? [`Description: ${evalCase.description}`] : []),
			`Suite file: ${path.relative(REPO_ROOT, suite.filePath)}`,
			...attempts.map(formatAttemptResult),
		].join("\n\n"),
	);
}

module.exports = {
	PROMPT_EVALS_ROOT,
	loadPromptEvalSuites,
	assertPromptEvalCase,
};
