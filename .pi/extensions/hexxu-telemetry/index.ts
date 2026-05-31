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
 *   exit_reason     pi's SessionShutdownEvent.reason — open-set string,
 *                   currently "quit" | "reload" | "new" | "resume" | "fork"
 *                   but pi may extend this set in future versions; we pass
 *                   the value through verbatim for forward compatibility
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
	renameSync,
	statSync,
	unlinkSync,
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
// T13.12: SKILL.md must live under a "skills/" parent (e.g., `~/.pi/agent/skills/central/<name>/SKILL.md`
// or a project-local `.pi/skills/<name>/SKILL.md`). The /skills/ segment scopes the match so unrelated
// SKILL.md files elsewhere on disk don't get counted as skill invocations.
const SKILL_PATH_RE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

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
	const maxBytes = parseNonNegativeInt(process.env.HEXXU_TELEMETRY_MAX_BYTES, DEFAULT_MAX_BYTES);
	const maxDays = parseNonNegativeInt(process.env.HEXXU_TELEMETRY_MAX_DAYS, DEFAULT_MAX_DAYS);
	return { dir, file, disabled, maxBytes, maxDays };
}

// T13.13: name says "non-negative" because it accepts 0; rotation can be
// effectively disabled by setting MAX_BYTES or MAX_DAYS to a huge number,
// but setting it to 0 would rotate on every write which is a config error
// the caller wants reported in the cfg, not silently substituted.
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
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

// T13.9: rotation via atomic-rename-as-claim (no flockSync in node:fs).
// Two concurrent pi sessions could both decide to rotate. The previous
// design (readFileSync → writeFileSync(file, "")) could lose records: B
// reads after A truncates, archiving an empty file; or both write to the
// same archive name. Fix: rename(2) the active log to a private claim
// name first. Only one process can win the rename — the loser gets ENOENT
// and skips. Subsequent appenders (any session) open `file` with O_CREAT
// and start a fresh log. No data is lost across the boundary.
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

	// Compute archive path (collision-resolved)
	const isoDate = new Date(st.mtimeMs).toISOString().slice(0, 10);
	const archiveBase = `telemetry-${isoDate}.jsonl`;
	let archiveName = `${archiveBase}.gz`;
	let archivePath = join(dirname(file), archiveName);
	let suffix = 1;
	while (existsSync(archivePath)) {
		suffix += 1;
		archiveName = `${archiveBase}.${suffix}.gz`;
		archivePath = join(dirname(file), archiveName);
	}

	// Atomic claim: rename the active log to a private name. If two pi sessions
	// race here, only one's renameSync succeeds; the loser catches ENOENT and
	// returns. POSIX rename(2) is atomic on the same filesystem.
	const claimPath = `${file}.rotating-${process.pid}-${Date.now()}`;
	try {
		renameSync(file, claimPath);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			// Another process already claimed it. No-op.
			return;
		}
		note(ctx, `rotation claim failed: ${errMessage(e)}; continuing to append to current file`, "warn");
		return;
	}

	// We hold exclusive ownership of claimPath. Process it.
	try {
		const data = readFileSync(claimPath);
		const gz = gzipSync(data);
		writeFileSync(archivePath, gz, { mode: 0o600 });
		try {
			unlinkSync(claimPath);
		} catch (e) {
			// Archive written successfully; failing to unlink the claim is non-fatal
			// (leftover will be cleaned by the next sync or the worker).
			note(ctx, `archive written but could not unlink ${claimPath}: ${errMessage(e)}`, "warn");
		}
		const reason = sizeExceeded ? `size > ${cfg.maxBytes}B` : `age > ${cfg.maxDays}d`;
		note(ctx, `rotated ${file} → ${archiveName} (${reason})`, "info");
	} catch (e) {
		// Archive write failed. Attempt to restore the claimed file so we don't
		// lose data. Subsequent writes will go to the restored file.
		try {
			renameSync(claimPath, file);
		} catch (e2) {
			note(
				ctx,
				`rotation archive failed AND restore failed: ${errMessage(e)} / ${errMessage(e2)}; claim left at ${claimPath}`,
				"error",
			);
			return;
		}
		note(ctx, `rotation failed (${errMessage(e)}); restored to active log, continuing`, "warn");
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
	// NOTE (Windows): 0o600 is a near-no-op on NTFS — Node only maps it to the
	// read-only attribute, not an owner-only ACL. On Windows worker desktops the
	// privacy guarantee instead rides on the per-user %USERPROFILE% ACL (the file
	// lives under ~/.hexxu, inside the user's profile). Single-user desktops only;
	// see docs/onboarding.md. POSIX hosts get the real owner-only mode.
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
		state.workerId = null;
		state.warnedNoWorkerId = false;
		// T13.23: resolve worker_id eagerly at session_start. Constraint #7
		// (identity rotation) says a new UUID = a new worker; resolving lazily at
		// session_shutdown would cross-link an old-worker session with the new
		// UUID if the worker rotated their HEXXU_WORKER_ID mid-session. Eager
		// resolution binds the session to whoever owned identity at start.
		readWorkerId(state, ctx);
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
			// T13.14: resolve worker_id at call time so a late-set env var (or just
			// the initial resolution failing during session_start when the shell env
			// wasn't yet exported) shows up correctly.
			readWorkerId(state, ctx);
			const lines = [
				`telemetry file: ${cfg.file}`,
				`worker_id: ${state.workerId ?? "(unset)"}`,
				`session_id: ${state.sessionId ?? "(none)"}`,
				`skills invoked this session: ${state.skills.size}`,
				`disabled: ${cfg.disabled}`,
			];
			note(ctx, lines.join(" | "), "info");
		},
	});
}
