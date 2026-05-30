#!/usr/bin/env -S node --experimental-strip-types
/**
 * hexxu-telemetry-summary
 *
 * Reads the local hexxu-telemetry JSONL log and prints a rollup for a time
 * window. Foundation for the CEO-plan-D5.3 observability mitigation (Risk
 * #7): "telemetry exists but no one looks" is the failure pattern; this CLI
 * makes the data trivially accessible from day 1.
 *
 * Usage:
 *   hexxu-telemetry-summary [--since DURATION] [--file PATH] [--format text|json]
 *
 *   --since   Time window. Supported units: s, m, h, d, w. Default: 7d.
 *             Examples: 30m, 24h, 7d, 4w.
 *   --file    Path to the telemetry JSONL. Default: $HEXXU_TELEMETRY_FILE
 *             or ~/.hexxu/telemetry/telemetry.jsonl.
 *   --format  Output format: "text" (default, human-readable) or "json".
 *
 * Scope notes:
 *   - V1 reads the ACTIVE JSONL only (no archive merging). If you need
 *     long-window queries that span rotations, concatenate archives via
 *     `zcat telemetry-*.jsonl.gz telemetry.jsonl > /tmp/merged.jsonl` and
 *     point this with `--file /tmp/merged.jsonl`.
 *   - V1 does NOT report per-skill duration percentiles. The locked schema
 *     records SESSION duration, not per-skill duration; attributing one to
 *     the other would mislead. We report invocation counts per skill and
 *     duration percentiles at the session level.
 *
 * Exits:
 *   0  Success
 *   1  Argument error (bad flag, unparseable --since)
 *   2  Telemetry file missing or unreadable
 *   3  Telemetry file empty (or no records match window)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ExitReason = "quit" | "reload" | "new" | "resume" | "fork" | string;

interface TelemetryRecord {
	event_at: string;
	worker_id: string;
	session_id: string | null;
	skills_invoked: Array<{ name: string; version: string | null }>;
	duration_ms: number;
	exit_reason: ExitReason;
	// Optional / forward-compat fields — pass through, ignore for now
	[key: string]: unknown;
}

interface Args {
	since: string;
	file: string;
	format: "text" | "json";
}

interface ParsedArgs extends Args {
	sinceMs: number;
}

function defaultFile(): string {
	return process.env.HEXXU_TELEMETRY_FILE ?? join(homedir(), ".hexxu", "telemetry", "telemetry.jsonl");
}

function printUsage(stream: NodeJS.WriteStream = process.stderr): void {
	stream.write(`Usage: hexxu-telemetry-summary [--since DURATION] [--file PATH] [--format text|json]

Options:
  --since DURATION   Time window (s/m/h/d/w). Default: 7d. Example: --since 24h
  --file PATH        Telemetry JSONL path. Default: ~/.hexxu/telemetry/telemetry.jsonl
  --format text|json Output format. Default: text
  -h, --help         Show this message
`);
}

function parseDuration(s: string): number | null {
	// Returns milliseconds, or null if unparseable. Supports: 30s, 5m, 12h, 7d, 4w.
	const m = s.match(/^(\d+)\s*([smhdw])$/i);
	if (!m) return null;
	const n = Number.parseInt(m[1], 10);
	if (!Number.isFinite(n) || n < 0) return null;
	const unit = m[2].toLowerCase();
	const multiplier: Record<string, number> = {
		s: 1000,
		m: 1000 * 60,
		h: 1000 * 60 * 60,
		d: 1000 * 60 * 60 * 24,
		w: 1000 * 60 * 60 * 24 * 7,
	};
	return n * multiplier[unit];
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
	const args: Args = {
		since: "7d",
		file: defaultFile(),
		format: "text",
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") {
			printUsage(process.stdout);
			process.exit(0);
		}
		const eq = a.indexOf("=");
		const k = eq === -1 ? a : a.slice(0, eq);
		const inlineV = eq === -1 ? undefined : a.slice(eq + 1);
		switch (k) {
			case "--since": {
				const v = inlineV ?? argv[++i];
				if (!v) return { error: "--since requires a value" };
				args.since = v;
				break;
			}
			case "--file": {
				const v = inlineV ?? argv[++i];
				if (!v) return { error: "--file requires a value" };
				args.file = v;
				break;
			}
			case "--format": {
				const v = inlineV ?? argv[++i];
				if (v !== "text" && v !== "json") return { error: `--format must be 'text' or 'json' (got '${v}')` };
				args.format = v;
				break;
			}
			default:
				return { error: `unknown argument: ${a}` };
		}
	}
	const sinceMs = parseDuration(args.since);
	if (sinceMs === null) {
		return { error: `--since must be a number followed by s/m/h/d/w (got '${args.since}')` };
	}
	return { ...args, sinceMs };
}

function readRecords(file: string): TelemetryRecord[] | { error: string; code: number } {
	if (!existsSync(file)) {
		return { error: `telemetry file not found: ${file}`, code: 2 };
	}
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (e) {
		return { error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, code: 2 };
	}
	const records: TelemetryRecord[] = [];
	let lineNo = 0;
	let skipped = 0;
	for (const line of raw.split("\n")) {
		lineNo++;
		const t = line.trim();
		if (!t) continue;
		try {
			const obj = JSON.parse(t) as TelemetryRecord;
			// Lightly validate required fields; skip malformed records loudly
			if (typeof obj.event_at !== "string" || typeof obj.duration_ms !== "number") {
				skipped++;
				continue;
			}
			records.push(obj);
		} catch {
			skipped++;
		}
	}
	if (skipped > 0) {
		process.stderr.write(`[warn] skipped ${skipped} malformed line(s) in ${file}\n`);
	}
	return records;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0];
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	const w = idx - lo;
	return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function fmtMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(2)}h`;
}

interface Summary {
	period: { since_iso: string; until_iso: string; window: string };
	source: string;
	sessions_in_period: number;
	sessions_total_in_file: number;
	skills: Array<{ name: string; invocations: number; versions: string[] }>;
	exit_reasons: Record<string, number>;
	duration_ms: { p50: number; p99: number; mean: number; total: number };
}

function summarize(records: TelemetryRecord[], args: ParsedArgs): Summary {
	const now = Date.now();
	const sinceMs = now - args.sinceMs;
	const sinceIso = new Date(sinceMs).toISOString();
	const untilIso = new Date(now).toISOString();

	// Filter to records inside the window
	const inWindow = records.filter((r) => {
		const t = Date.parse(r.event_at);
		return Number.isFinite(t) && t >= sinceMs && t <= now;
	});

	// Skill counts
	const skillCounts = new Map<string, { invocations: number; versions: Set<string> }>();
	for (const r of inWindow) {
		for (const s of r.skills_invoked ?? []) {
			if (!s?.name) continue;
			const slot = skillCounts.get(s.name) ?? { invocations: 0, versions: new Set<string>() };
			slot.invocations++;
			if (s.version) slot.versions.add(s.version);
			skillCounts.set(s.name, slot);
		}
	}
	const skills = Array.from(skillCounts.entries())
		.map(([name, v]) => ({ name, invocations: v.invocations, versions: [...v.versions].sort() }))
		.sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name));

	// Exit reasons
	const exitReasons: Record<string, number> = {};
	for (const r of inWindow) {
		const k = r.exit_reason ?? "(unknown)";
		exitReasons[k] = (exitReasons[k] ?? 0) + 1;
	}

	// Duration stats
	const durations = inWindow
		.map((r) => r.duration_ms)
		.filter((d) => Number.isFinite(d) && d >= 0)
		.sort((a, b) => a - b);
	const totalDuration = durations.reduce((a, b) => a + b, 0);
	const meanDuration = durations.length > 0 ? totalDuration / durations.length : 0;

	return {
		period: { since_iso: sinceIso, until_iso: untilIso, window: args.since },
		source: args.file,
		sessions_in_period: inWindow.length,
		sessions_total_in_file: records.length,
		skills,
		exit_reasons: exitReasons,
		duration_ms: {
			p50: percentile(durations, 0.5),
			p99: percentile(durations, 0.99),
			mean: meanDuration,
			total: totalDuration,
		},
	};
}

function renderText(s: Summary): string {
	const lines: string[] = [];
	lines.push("hexxu telemetry-summary");
	lines.push("=======================");
	lines.push(`Period: ${s.period.since_iso} → ${s.period.until_iso} (window: ${s.period.window})`);
	lines.push(`Source: ${s.source}`);
	lines.push(`Sessions in period: ${s.sessions_in_period}  (file total: ${s.sessions_total_in_file})`);
	lines.push("");
	lines.push("Skills invoked (by count):");
	if (s.skills.length === 0) {
		lines.push("  (none)");
	} else {
		const maxNameLen = Math.max(...s.skills.map((sk) => sk.name.length));
		for (const sk of s.skills) {
			const padName = sk.name.padEnd(maxNameLen);
			const versions = sk.versions.length > 0 ? ` [v ${sk.versions.join(",")}]` : "";
			lines.push(`  ${padName}  ${String(sk.invocations).padStart(4)}${versions}`);
		}
	}
	lines.push("");
	lines.push("Exit reasons:");
	const reasonKeys = Object.keys(s.exit_reasons).sort((a, b) => s.exit_reasons[b] - s.exit_reasons[a]);
	if (reasonKeys.length === 0) {
		lines.push("  (none)");
	} else {
		const reasonMax = Math.max(...reasonKeys.map((r) => r.length));
		for (const r of reasonKeys) {
			const pct = s.sessions_in_period > 0 ? ((s.exit_reasons[r] / s.sessions_in_period) * 100).toFixed(0) : "0";
			lines.push(`  ${r.padEnd(reasonMax)}  ${String(s.exit_reasons[r]).padStart(4)}  (${pct}%)`);
		}
	}
	lines.push("");
	lines.push("Session duration (across all sessions in period):");
	if (s.sessions_in_period === 0) {
		lines.push("  (no sessions)");
	} else {
		lines.push(`  p50:   ${fmtMs(s.duration_ms.p50)}`);
		lines.push(`  p99:   ${fmtMs(s.duration_ms.p99)}`);
		lines.push(`  mean:  ${fmtMs(s.duration_ms.mean)}`);
		lines.push(`  total: ${fmtMs(s.duration_ms.total)}`);
	}
	return lines.join("\n") + "\n";
}

function main(): number {
	const parsed = parseArgs(process.argv.slice(2));
	if ("error" in parsed) {
		process.stderr.write(`error: ${parsed.error}\n\n`);
		printUsage(process.stderr);
		return 1;
	}

	const result = readRecords(parsed.file);
	if (!Array.isArray(result)) {
		process.stderr.write(`error: ${result.error}\n`);
		return result.code;
	}

	const summary = summarize(result, parsed);
	if (summary.sessions_total_in_file === 0) {
		process.stderr.write(`no telemetry records in ${parsed.file}\n`);
		return 3;
	}

	if (parsed.format === "json") {
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	} else {
		process.stdout.write(renderText(summary));
	}
	return 0;
}

process.exit(main());
