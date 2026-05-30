#!/usr/bin/env -S node --experimental-strip-types

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { assertPromptEvalCase, loadPromptEvalSuites } = require("../harness.ts");

const suites = loadPromptEvalSuites();
const hasOpenAIKey = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim().length > 0;

describe("prompt eval harness", () => {
	test("loads at least one prompt eval suite", () => {
		assert.ok(suites.length > 0, "expected at least one *.eval.json suite under evals/prompts");
	});
});

describe("prompt evals (direct openai gpt-4o-mini)", { skip: !hasOpenAIKey }, () => {
	for (const suite of suites) {
		describe(suite.suiteId, () => {
			for (const evalCase of suite.cases) {
				const repeat = evalCase.repeat ?? suite.defaults.repeat ?? 1;
				const timeoutMs = (evalCase.timeoutMs ?? suite.defaults.timeoutMs ?? 30000) * repeat + 5000;
				const label = evalCase.description ? `${evalCase.id} — ${evalCase.description}` : evalCase.id;

				test(label, { timeout: timeoutMs }, async () => {
					await assertPromptEvalCase(suite, evalCase, process.env.OPENAI_API_KEY);
				});
			}
		});
	}
});

test("prints a helpful note when OPENAI_API_KEY is missing", { skip: hasOpenAIKey }, () => {
	console.log("OPENAI_API_KEY is not set; direct prompt eval cases were skipped.");
});
