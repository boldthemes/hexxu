/**
 * hexxu-telemetry
 *
 * Pi extension that captures one JSONL telemetry record per pi session.
 * Local-only by default. Foundation for the `hexxu telemetry-summary` CLI (T8)
 * and the future postgres-backed analytics in phase B.
 *
 * Locked schema (forward-compatible — additions OK, removals NOT OK):
 *
 *   event_at        ISO 8601 UTC timestamp of the session_shutdown
 *   worker_id       UUID v4 from HEXXU_WORKER_ID (raw, local-only)
 *   session_id      Pi's session id (ctx.sessionManager.getSessionId())
 *   skills_invoked  Array of { name, version }, deduped by name
 *   duration_ms     session end - session start in milliseconds
 *   exit_reason     "quit" | "reload" | "new" | "resume" | "fork"
 *
 * Optional fields the implementer (you, today) may add without breaking
 * forward compatibility: model, total_tokens, exit_code, custom_props, etc.
 *
 * Configuration (env vars, all optional):
 *
 *   HEXXU_TELEMETRY_DIR        ~/.hexxu/telemetry by default
 *   HEXXU_TELEMETRY_FILE       <dir>/telemetry.jsonl by default
 *   HEXXU_TELEMETRY_DISABLED   "1"/"true"/"yes" disables telemetry entirely
 *   HEXXU_TELEMETRY_MAX_BYTES  50 * 1024 * 1024 by default (rotate when >)
 *   HEXXU_TELEMETRY_MAX_DAYS   90 by default (rotate when older)
 *
 * If HEXXU_WORKER_ID is not set, this extension WARNs once per session and
 * skips writing. We don't fall back to a placeholder UUID because that would
 * pollute the telemetry stream with anonymous data the owner can't link back
 * to themselves. Onboarding flow (T9) makes sure HEXXU_WORKER_ID is set.
 *
 * Failure semantics: any disk/permission/rotation failure WARNs to stderr +
 * ctx.ui.notify and returns. Telemetry is best-effort; pi sessions never
 * block on it (constraint #5).
 *
 * CEO-plan refs: T7, manifest schema (T5) for skill name/version, Risk #4
 * (telemetry privacy: local-only, mode 0600), Risk #7 mitigation
 * (`hexxu telemetry-summary` CLI in T8 consumes this file).
 */

import {
	closeSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

const TAG = "hexxu-telemetry";
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_DAYS = 90;
const UUID_V4_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
// Matches Read tool calls whose path ends in /<skill-name>/SKILL.md. Captures the skill-name dir.
const SKILL_PATH_RE = /(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/;

interface SessionState {
	sessionId: string | null;
	startMs: number;
	// Map keyed by skill name → version (or null if unparseable). Dedupes invocations.
	skills: Map<string, string | null>;
	workerId: string | null;
	warnedNoWorkerId: boolean;
}

interface Config {
	dir: string;
	file: string;
	disabled: boolean;
	maxBytes: number;
	maxDays: number;
}

function readConfig(): Config {
	const home = homedir();
	const dir = process.env.HEXXU_TELEMETRY_DIR ?? join(home, ".hexxu", "telemetry");
	const file = process.env.HEXXU_TELEMETRY_FILE ?? join(dir, "telemetry.jsonl");
	const disabled = ["1", "true", "yes"].includes((process.env.HEXXU_TELEMETRY_DISABLED ?? "").toLowerCase());
	const maxBytes = parsePositiveInt(process.env.HEXXU_TELEMETRY_MAX_BYTES, DEFAULT_MAX_BYTES);
	const maxDays = parsePositiveInt(process.env.HEXXU_TELEMETRY_MAX_DAYS, DEFAULT_MAX_DAYS);
	return { dir, file, disabled, maxBytes, maxDays };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function note(ctx: ExtensionContext | undefined, msg: string, level: "info" | "warn" | "error" = "info"): void {
	const line = `${TAG}: ${msg}`;
	if (ctx?.hasUI) ctx.ui.notify(line, level);
	process.stderr.write(`${line}\n`);
}

function readWorkerId(state: SessionState, ctx: ExtensionContext | undefined): string | null {
	if (state.workerId) return state.workerId;
	const raw = process.env.HEXXU_WORKER_ID?.trim();
	if (!raw) {
		if (!state.warnedNoWorkerId) {
			note(
				ctx,
				"HEXXU_WORKER_ID is not set; skipping telemetry for this session. Set it per docs/onboarding.md in hexxu-skills.",
				"warn",
			);
			state.warnedNoWorkerId = true;
		}
		return null;
	}
	if (!UUID_V4_RE.test(raw)) {
		if (!state.warnedNoWorkerId) {
			note(ctx, `HEXXU_WORKER_ID is not a valid UUID v4 ("${raw.slice(0, 16)}..."); skipping telemetry.`, "warn");
			state.warnedNoWorkerId = true;
		}
		return null;
	}
	state.workerId = raw;
	return raw;
}

/**
 * Read the version field from a SKILL.md frontmatter. Returns null if absent
 * or the file can't be read. Uses a minimal regex — no full YAML parser
 * needed for a flat top-level scalar.
 */
function readSkillVersion(skillMdPath: string): string | null {
	try {
		const text = readFileSync(skillMdPath, "utf8");
		// Frontmatter is between leading `---\n` and the next `---\n`
		const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
		if (!fmMatch) return null;
		const versionMatch = fmMatch[1].match(/^version:\s*(.+)$/m);
		if (!versionMatch) return null;
		return versionMatch[1].trim() || null;
	} catch {
		return null;
	}
}

function maybeRotate(file: string, cfg: Config, ctx: ExtensionContext | undefined): void {
	if (!existsSync(file)) return;
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(file);
	} catch (e) {
		note(ctx, `cannot stat ${file}: ${errMessage(e)}`, "warn");
		return;
	}

	const ageDays = (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24);
	const sizeExceeded = st.size > cfg.maxBytes;
	const ageExceeded = ageDays > cfg.maxDays;
	if (!sizeExceeded && !ageExceeded) return;

	// Rotate: rename to telemetry-YYYY-MM-DD.jsonl.gz and start fresh
	const isoDate = new Date(st.mtimeMs).toISOString().slice(0, 10);
	const archiveBase = `telemetry-${isoDate}.jsonl`;
	let archiveName = `${archiveBase}.gz`;
	let archivePath = join(dirname(file), archiveName);
	// Avoid collisions if rotation happens twice on the same date
	let suffix = 1;
	while (existsSync(archivePath)) {
		suffix += 1;
		archiveName = `${archiveBase}.${suffix}.gz`;
		archivePath = join(dirname(file), archiveName);
	}

	try {
		// 1. Read the current log
		const data = readFileSync(file);
		// 2. Gzip and write the archive (mode 0o600 from the start)
		const gz = gzipSync(data);
		writeFileSync(archivePath, gz, { mode: 0o600 });
		// 3. Truncate the original so subsequent appends start fresh.
		//    Single-process model = no concurrent writes during rotation.
		writeFileSync(file, "", { mode: 0o600 });
		const reason = sizeExceeded ? `size > ${cfg.maxBytes}B` : `age > ${cfg.maxDays}d`;
		note(ctx, `rotated ${file} → ${archiveName} (${reason})`, "info");
	} catch (e) {
		// Rotation failed (most often: archive write permission). Leave the
		// original file in place; the next append still works (mode might be
		// outdated but data isn't lost).
		note(ctx, `rotation failed (${errMessage(e)}); continuing to append to current file`, "warn");
	}
}

function writeJsonlRecord(file: string, cfg: Config, record: object, ctx: ExtensionContext | undefined): void {
	try {
		mkdirSync(cfg.dir, { recursive: true });
	} catch (e) {
		note(ctx, `cannot create ${cfg.dir}: ${errMessage(e)}`, "warn");
		return;
	}

	maybeRotate(file, cfg, ctx);

	// O_WRONLY | O_CREAT | O_APPEND. Mode 0o600 on create.
	let fd: number | null = null;
	try {
		fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
		const line = `${JSON.stringify(record)}\n`;
		// POSIX guarantees atomic appends for write() < PIPE_BUF (typically 4096 on Linux);
		// our records are well under that.
		writeSync(fd, line);
	} catch (e) {
		note(ctx, `failed to write telemetry record: ${errMessage(e)}`, "warn");
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* swallow */
			}
		}
	}
}

export default function hexxuTelemetry(pi: ExtensionAPI): void {
	// Per-session in-memory state. Lives only while the runtime is up.
	const state: SessionState = {
		sessionId: null,
		startMs: Date.now(),
		skills: new Map(),
		workerId: null,
		warnedNoWorkerId: false,
	};

	pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
		state.sessionId = ctx.sessionManager.getSessionId() ?? null;
		state.startMs = Date.now();
		state.skills = new Map();
		// Resolve worker_id lazily on shutdown so a late-set env var still works
		state.workerId = null;
		state.warnedNoWorkerId = false;
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "read") return;
		const args = (event.args ?? {}) as { path?: unknown };
		const path = typeof args.path === "string" ? args.path : "";
		if (!path) return;
		const m = path.match(SKILL_PATH_RE);
		if (!m) return;
		const skillName = m[1];
		// Skip if we've already recorded this skill this session
		if (state.skills.has(skillName)) return;
		// Best-effort version lookup; null if unmigrated or unreadable
		const version = readSkillVersion(path);
		state.skills.set(skillName, version);
	});

	pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx) => {
		const cfg = readConfig();
		if (cfg.disabled) {
			// Quiet: explicit opt-out, no log noise
			return;
		}
		const workerId = readWorkerId(state, ctx);
		if (!workerId) {
			// Already warned in readWorkerId
			return;
		}

		const skillsInvoked = Array.from(state.skills.entries()).map(([name, version]) => ({ name, version }));
		const record = {
			event_at: new Date().toISOString(),
			worker_id: workerId,
			session_id: state.sessionId,
			skills_invoked: skillsInvoked,
			duration_ms: Math.max(0, Date.now() - state.startMs),
			exit_reason: event.reason,
		};
		writeJsonlRecord(cfg.file, cfg, record, ctx);
		// Brief success ack to stderr so workers can observe behavior in dev
		note(
			ctx,
			`logged session ${state.sessionId?.slice(0, 8) ?? "?"} (skills=${skillsInvoked.length}, reason=${event.reason})`,
			"info",
		);
	});

	// Inspectable status command
	pi.registerCommand("telemetry-status", {
		description: "Show hexxu-telemetry state for the current session and on-disk log location",
		handler: async (_args, ctx) => {
			const cfg = readConfig();
			const lines = [
				`telemetry file: ${cfg.file}`,
				`worker_id: ${state.workerId ?? "(not yet resolved)"}`,
				`session_id: ${state.sessionId ?? "(none)"}`,
				`skills invoked this session: ${state.skills.size}`,
				`disabled: ${cfg.disabled}`,
			];
			note(ctx, lines.join(" | "), "info");
		},
	});
}
