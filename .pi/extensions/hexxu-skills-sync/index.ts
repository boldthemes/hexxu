/**
 * hexxu-skills-sync
 *
 * Pi extension that pulls the central hexxu skills registry into the local
 * pi skills directory at session start.
 *
 * Design constraints (from the CEO plan; do not violate):
 *
 *   1. Non-blocking: any failure (network, auth, disk) WARNs to stderr +
 *      ctx.ui.notify but never blocks the pi session start.
 *   2. Cold-start fail-open: if there's no cached clone AND GitHub is
 *      unreachable, we start with no central skills + a visible warning.
 *      Constraint #5 in CLAUDE.md.
 *   3. Staleness cache: skip git fetch if the last successful sync is < 5
 *      minutes old. Avoids hammering GitHub on rapid session start cycles.
 *   4. Registry URL is configurable (HEXXU_SKILLS_URL); never hard-coded.
 *      Constraint #3.
 *
 * Lifecycle: triggers on `session_start`. The sync runs async so the session
 * boot is never blocked. Skills land on disk for the NEXT pi session
 * (current session uses whatever was cached at boot). Workers who need
 * "latest now" run `/sync-skills` and start a new session.
 *
 * Configuration (env vars, all optional):
 *
 *   HEXXU_SKILLS_URL          git URL of the registry repo
 *                             default: https://github.com/boldthemes/hexxu-skills.git
 *   HEXXU_SKILLS_CACHE_DIR    local clone target
 *                             default: ~/.hexxu/skills-cache
 *   HEXXU_SKILLS_MOUNT        symlink target into pi's skills dir
 *                             default: ~/.pi/agent/skills/central
 *   HEXXU_SKILLS_STALENESS_S  seconds between automatic syncs
 *                             default: 300
 *   HEXXU_SKILLS_DISABLED     "1" / "true" / "yes" disables sync entirely
 *
 * State file: ~/.hexxu/skills-sync-state.json
 *
 * CEO-plan refs: T4, constraints #3 and #5, Risk #6 (sync is the channel
 * that prompt-injection PRs would land through; combined with branch
 * protection on the central repo, this is the layered defense).
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SyncState {
	last_sync_at: number;
	last_sync_status: "success" | "failure";
	last_sync_message: string;
	head_sha?: string;
}

interface SyncConfig {
	url: string;
	cacheDir: string;
	mountPoint: string;
	stalenessMs: number;
	disabled: boolean;
}

const DEFAULT_URL = "https://github.com/boldthemes/hexxu-skills.git";
const DEFAULT_STALENESS_SECONDS = 300;
const TAG = "hexxu-skills-sync";

function readConfig(): SyncConfig {
	const home = homedir();
	// Parse with explicit numeric validation so HEXXU_SKILLS_STALENESS_S=0
	// (force every sync) is honored. The naive `parsed || DEFAULT` form
	// substituted DEFAULT for 0 because 0 is falsy.
	const stalenessSecondsRaw = process.env.HEXXU_SKILLS_STALENESS_S;
	let stalenessSeconds = DEFAULT_STALENESS_SECONDS;
	if (stalenessSecondsRaw !== undefined && stalenessSecondsRaw !== "") {
		const parsed = Number.parseInt(stalenessSecondsRaw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) {
			stalenessSeconds = parsed;
		}
	}
	return {
		url: process.env.HEXXU_SKILLS_URL ?? DEFAULT_URL,
		cacheDir: process.env.HEXXU_SKILLS_CACHE_DIR ?? join(home, ".hexxu", "skills-cache"),
		mountPoint: process.env.HEXXU_SKILLS_MOUNT ?? join(home, ".pi", "agent", "skills", "central"),
		stalenessMs: stalenessSeconds * 1000,
		disabled: ["1", "true", "yes"].includes((process.env.HEXXU_SKILLS_DISABLED ?? "").toLowerCase()),
	};
}

function stateFilePath(cacheDir: string): string {
	// State lives in the cache dir's parent (alongside the cache, not inside it,
	// so a stale cache wipe doesn't lose sync history)
	return join(dirname(cacheDir), "skills-sync-state.json");
}

function readState(stateFile: string): SyncState | null {
	if (!existsSync(stateFile)) return null;
	try {
		const raw = readFileSync(stateFile, "utf8");
		return JSON.parse(raw) as SyncState;
	} catch {
		// Corrupted state file; treat as missing
		return null;
	}
}

function writeState(stateFile: string, state: SyncState): void {
	try {
		mkdirSync(dirname(stateFile), { recursive: true });
		writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
	} catch (e) {
		// State write failed; non-fatal — log to stderr only
		process.stderr.write(`${TAG}: failed to persist state: ${errMessage(e)}\n`);
	}
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function note(ctx: ExtensionContext | undefined, msg: string, level: "info" | "warn" | "error" = "info"): void {
	const line = `${TAG}: ${msg}`;
	if (ctx?.hasUI) {
		// pi.ui.notify accepts "info" | "warn" | "error" (per the tps.ts and redraws.ts examples)
		ctx.ui.notify(line, level);
	}
	// Always emit to stderr for headless visibility and log capture
	process.stderr.write(`${line}\n`);
}

function ensureMount(cacheDir: string, mountPoint: string, ctx: ExtensionContext | undefined): boolean {
	const cacheSkills = join(cacheDir, "skills");
	if (!existsSync(cacheSkills)) {
		// No skills dir inside the cache yet — cold start or empty registry
		return false;
	}

	try {
		mkdirSync(dirname(mountPoint), { recursive: true });
	} catch (e) {
		note(ctx, `cannot create parent of mount ${mountPoint}: ${errMessage(e)}`, "warn");
		return false;
	}

	if (existsSync(mountPoint)) {
		let isSymlink = false;
		try {
			isSymlink = lstatSync(mountPoint).isSymbolicLink();
		} catch (e) {
			note(ctx, `cannot inspect mount ${mountPoint}: ${errMessage(e)}`, "warn");
			return false;
		}
		if (!isSymlink) {
			// Real directory or file with worker-local content — do NOT destroy
			note(
				ctx,
				`mount ${mountPoint} exists and is not a symlink; not overwriting. Move/rename it to enable central sync.`,
				"warn",
			);
			return false;
		}
		// Existing symlink — replace to re-point at the current cache
		try {
			unlinkSync(mountPoint);
		} catch (e) {
			note(ctx, `cannot replace existing symlink ${mountPoint}: ${errMessage(e)}`, "warn");
			return false;
		}
	}

	try {
		symlinkSync(cacheSkills, mountPoint, "dir");
		return true;
	} catch (e) {
		note(ctx, `cannot create symlink ${mountPoint} -> ${cacheSkills}: ${errMessage(e)}`, "warn");
		return false;
	}
}

async function performSync(pi: ExtensionAPI, ctx: ExtensionContext | undefined, force: boolean): Promise<void> {
	const cfg = readConfig();
	if (cfg.disabled) {
		note(ctx, "disabled via HEXXU_SKILLS_DISABLED; skipping", "info");
		return;
	}

	const stateFile = stateFilePath(cfg.cacheDir);
	const state = readState(stateFile);

	// Staleness short-circuit
	if (!force && state?.last_sync_at && state.last_sync_status === "success") {
		const ageMs = Date.now() - state.last_sync_at;
		if (ageMs < cfg.stalenessMs) {
			note(
				ctx,
				`cache fresh (${Math.round(ageMs / 1000)}s old, cutoff ${Math.round(cfg.stalenessMs / 1000)}s); skipping fetch`,
				"info",
			);
			// Still ensure the mount is in place in case it got removed since last sync
			ensureMount(cfg.cacheDir, cfg.mountPoint, ctx);
			return;
		}
	}

	const isFirstSync = !existsSync(cfg.cacheDir);
	let exitCode = 0;
	let stderrTail = "";
	let headSha = state?.head_sha;

	if (isFirstSync) {
		note(ctx, `cold-start: cloning ${cfg.url} into ${cfg.cacheDir}`, "info");
		try {
			mkdirSync(dirname(cfg.cacheDir), { recursive: true });
		} catch (e) {
			note(ctx, `cannot create cache parent ${dirname(cfg.cacheDir)}: ${errMessage(e)}`, "warn");
			return;
		}
		const r = await pi.exec("git", ["clone", "--depth", "1", "--branch", "main", cfg.url, cfg.cacheDir]);
		exitCode = r.code;
		stderrTail = r.stderr;
	} else {
		const fetched = await pi.exec("git", ["-C", cfg.cacheDir, "fetch", "--depth", "1", "origin", "main"]);
		if (fetched.code !== 0) {
			exitCode = fetched.code;
			stderrTail = fetched.stderr;
		} else {
			const reset = await pi.exec("git", ["-C", cfg.cacheDir, "reset", "--hard", "FETCH_HEAD"]);
			exitCode = reset.code;
			stderrTail = reset.stderr;
		}
	}

	if (exitCode !== 0) {
		const failMsg =
			stderrTail.trim().split("\n").slice(0, 3).join(" | ").slice(0, 400) || "git failed with no stderr output";
		note(ctx, `sync failed: ${failMsg}`, "warn");
		writeState(stateFile, {
			last_sync_at: Date.now(),
			last_sync_status: "failure",
			last_sync_message: failMsg,
			head_sha: headSha,
		});
		if (isFirstSync) {
			note(ctx, "cold-start failed; starting with no central skills (fail-open per constraint #5)", "warn");
		}
		// Even on failure, attempt to mount whatever we have cached (no-op if cache is empty)
		ensureMount(cfg.cacheDir, cfg.mountPoint, ctx);
		return;
	}

	// Capture HEAD SHA
	const shaResult = await pi.exec("git", ["-C", cfg.cacheDir, "rev-parse", "HEAD"]);
	if (shaResult.code === 0) {
		headSha = shaResult.stdout.trim();
	}

	// Mount the central skills into pi's skills dir.
	// If the cache has no `skills/` subdir, that's expected during bootstrap
	// (the central registry hasn't received T6's grandfather migration yet) —
	// log as info, not warn. Any other mount failure is a real warning.
	const cacheSkillsDir = join(cfg.cacheDir, "skills");
	const mounted = ensureMount(cfg.cacheDir, cfg.mountPoint, ctx);
	if (!mounted) {
		if (!existsSync(cacheSkillsDir)) {
			note(ctx, "registry has no skills/ directory yet (expected during bootstrap)", "info");
		} else {
			note(ctx, "fetched but couldn't mount; central skills not visible to pi until next session", "warn");
		}
	}

	// Count skills in the cache for the success message
	const countResult = await pi.exec("sh", [
		"-c",
		`find "${join(cfg.cacheDir, "skills")}" -maxdepth 2 -name SKILL.md -type f 2>/dev/null | wc -l`,
	]);
	const skillCount = Number.parseInt(countResult.stdout.trim() || "0", 10) || 0;
	const shaShort = headSha?.substring(0, 7) ?? "?";

	const msg = `synced ${skillCount} skill${skillCount === 1 ? "" : "s"} @ ${shaShort}`;
	writeState(stateFile, {
		last_sync_at: Date.now(),
		last_sync_status: "success",
		last_sync_message: msg,
		head_sha: headSha,
	});
	note(ctx, msg, "info");
}

export default function hexxuSkillsSync(pi: ExtensionAPI): void {
	// Sync on every session start. Async + try/catch ensures no failure ever
	// blocks the session boot.
	pi.on("session_start", async (_event, ctx) => {
		try {
			await performSync(pi, ctx, /* force */ false);
		} catch (e) {
			note(ctx, `unexpected error during background sync: ${errMessage(e)}`, "warn");
		}
	});

	// Manual on-demand sync; bypasses the 5-min staleness cache.
	pi.registerCommand("sync-skills", {
		description: "Force-sync the hexxu central skills registry (ignores the 5-min staleness cache)",
		handler: async (_args, ctx) => {
			note(ctx, "manual sync requested", "info");
			try {
				await performSync(pi, ctx, /* force */ true);
			} catch (e) {
				note(ctx, `manual sync failed: ${errMessage(e)}`, "warn");
			}
		},
	});

	// Status read-out; useful for ops and the T8 telemetry-summary CLI to cross-reference
	pi.registerCommand("sync-skills-status", {
		description: "Show the last hexxu-skills-sync result (last sync time, status, head SHA)",
		handler: async (_args, ctx) => {
			const cfg = readConfig();
			const state = readState(stateFilePath(cfg.cacheDir));
			if (!state) {
				note(ctx, "no sync has run yet", "info");
				return;
			}
			const ageS = Math.round((Date.now() - state.last_sync_at) / 1000);
			const shaShort = state.head_sha?.substring(0, 7) ?? "?";
			note(
				ctx,
				`last sync ${ageS}s ago | status=${state.last_sync_status} | ${state.last_sync_message} | sha=${shaShort}`,
				state.last_sync_status === "success" ? "info" : "warn",
			);
		},
	});
}
