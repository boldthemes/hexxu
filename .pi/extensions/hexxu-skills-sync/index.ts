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

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SyncState {
	last_sync_at: number;
	last_sync_status: "success" | "failure";
	last_sync_message: string;
	head_sha?: string;
}

interface SyncConfig {
	url: string;
	branch: string;
	cacheDir: string;
	mountPoint: string;
	stalenessMs: number;
	disabled: boolean;
}

const DEFAULT_URL = "https://github.com/boldthemes/hexxu-skills.git";
const DEFAULT_BRANCH = "main";
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
		// T13.4: HEXXU_SKILLS_BRANCH lets you point at forks with non-main defaults
		// without breaking sync. Defaults to 'main' for the boldthemes/hexxu-skills convention.
		branch: process.env.HEXXU_SKILLS_BRANCH ?? DEFAULT_BRANCH,
		cacheDir: process.env.HEXXU_SKILLS_CACHE_DIR ?? join(home, ".hexxu", "skills-cache"),
		mountPoint: process.env.HEXXU_SKILLS_MOUNT ?? join(home, ".pi", "agent", "skills", "central"),
		stalenessMs: stalenessSeconds * 1000,
		disabled: ["1", "true", "yes"].includes((process.env.HEXXU_SKILLS_DISABLED ?? "").toLowerCase()),
	};
}

// T13.19: refuse to operate if HEXXU_SKILLS_MOUNT is inside HEXXU_SKILLS_CACHE_DIR.
// The atomic-publish swap would destroy the mount mid-flight, leaving pi with a
// dangling symlink. Returns true if config is safe; false (with warn) if not.
function validateConfig(cfg: SyncConfig, ctx: ExtensionContext | undefined): boolean {
	const cacheWithSep = cfg.cacheDir.endsWith(sep) ? cfg.cacheDir : cfg.cacheDir + sep;
	if (cfg.mountPoint === cfg.cacheDir || cfg.mountPoint.startsWith(cacheWithSep)) {
		note(
			ctx,
			`misconfiguration: HEXXU_SKILLS_MOUNT (${cfg.mountPoint}) is inside HEXXU_SKILLS_CACHE_DIR (${cfg.cacheDir}); refusing to sync to avoid destroying the mount`,
			"warn",
		);
		return false;
	}
	return true;
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

// T13.7: atomic symlink swap. The original lstatSync → unlinkSync → symlinkSync
// sequence has a TOCTOU window: between unlinkSync and symlinkSync, another
// pi session sees the mount point missing. POSIX rename(2) on a symlink is
// atomic — write a fresh symlink to a temp name, then rename it into place.
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

	// Refuse to overwrite a real directory/file at the mount point. Workers with
	// pre-existing skill content should move/rename it before enabling central sync.
	if (existsSync(mountPoint)) {
		let isSymlink = false;
		try {
			isSymlink = lstatSync(mountPoint).isSymbolicLink();
		} catch (e) {
			note(ctx, `cannot inspect mount ${mountPoint}: ${errMessage(e)}`, "warn");
			return false;
		}
		if (!isSymlink) {
			note(
				ctx,
				`mount ${mountPoint} exists and is not a symlink; not overwriting. Move/rename it to enable central sync.`,
				"warn",
			);
			return false;
		}
	}

	// Atomic swap: create the new symlink at a temp name, then rename it onto
	// the mount point. rename(2) is atomic for symlinks on POSIX filesystems.
	// Tempname includes pid to avoid collisions if two pi sessions run concurrently.
	const tempLink = `${mountPoint}.staging-${process.pid}`;
	try {
		if (existsSync(tempLink)) unlinkSync(tempLink);
	} catch {
		/* not fatal */
	}
	try {
		symlinkSync(cacheSkills, tempLink, "dir");
	} catch (e) {
		note(ctx, `cannot create staging symlink ${tempLink}: ${errMessage(e)}`, "warn");
		return false;
	}
	try {
		renameSync(tempLink, mountPoint);
		return true;
	} catch (e) {
		note(ctx, `cannot atomically swap mount ${mountPoint}: ${errMessage(e)}`, "warn");
		try {
			unlinkSync(tempLink);
		} catch {
			/* best effort cleanup */
		}
		return false;
	}
}

// T13.8: atomic cache publish helper. Removes any leftover staging/old dirs
// from a previous failed sync. Best-effort; logs warnings but doesn't fail.
function cleanupStagingDirs(cacheDir: string, ctx: ExtensionContext | undefined): void {
	for (const suffix of [".staging", ".old"]) {
		const path = `${cacheDir}${suffix}`;
		if (existsSync(path)) {
			try {
				rmSync(path, { recursive: true, force: true });
			} catch (e) {
				note(ctx, `could not clean up leftover ${path}: ${errMessage(e)}`, "warn");
			}
		}
	}
}

async function performSync(pi: ExtensionAPI, ctx: ExtensionContext | undefined, force: boolean): Promise<void> {
	const cfg = readConfig();
	if (cfg.disabled) {
		note(ctx, "disabled via HEXXU_SKILLS_DISABLED; skipping", "info");
		return;
	}

	// T13.19: refuse to sync if mount lives inside cache
	if (!validateConfig(cfg, ctx)) return;

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

	// T13.1+T13.8 unified design: every sync is a full shallow clone to a staging
	// dir, followed by an atomic rename swap. This kills three bugs at once:
	//   (1) URL drift — HEXXU_SKILLS_URL changes always take effect on the next
	//       sync because we never reuse the cache's embedded origin
	//   (2) In-place git reset --hard racing concurrent readers — atomic dir
	//       rename publishes the new cache without ever mutating the old in place
	//   (3) The cache+branch combination always matches the current config; no
	//       drift detection plumbing needed
	// Cost: a fresh shallow clone instead of fetch on every non-skipped sync.
	// hexxu-skills is small (KB-scale) so this is a no-op.
	const stagingDir = `${cfg.cacheDir}.staging`;
	const oldDir = `${cfg.cacheDir}.old`;
	const isFirstSync = !existsSync(cfg.cacheDir);
	let headSha = state?.head_sha;

	// Clean up any leftover from a prior crashed/killed sync
	cleanupStagingDirs(cfg.cacheDir, ctx);

	try {
		mkdirSync(dirname(cfg.cacheDir), { recursive: true });
	} catch (e) {
		note(ctx, `cannot create cache parent ${dirname(cfg.cacheDir)}: ${errMessage(e)}`, "warn");
		return;
	}

	note(
		ctx,
		isFirstSync
			? `cold-start: cloning ${cfg.url} (branch ${cfg.branch}) into ${cfg.cacheDir}`
			: `sync: cloning ${cfg.url} (branch ${cfg.branch}) into staging`,
		"info",
	);
	const cloneRes = await pi.exec("git", ["clone", "--depth", "1", "--branch", cfg.branch, cfg.url, stagingDir]);
	if (cloneRes.code !== 0) {
		const failMsg =
			cloneRes.stderr.trim().split("\n").slice(0, 3).join(" | ").slice(0, 400) || "git clone failed with no stderr";
		note(ctx, `sync failed: ${failMsg}`, "warn");
		writeState(stateFile, {
			last_sync_at: Date.now(),
			last_sync_status: "failure",
			last_sync_message: failMsg,
			head_sha: headSha,
		});
		// Clean up the failed staging dir
		cleanupStagingDirs(cfg.cacheDir, ctx);
		if (isFirstSync) {
			note(ctx, "cold-start failed; starting with no central skills (fail-open per constraint #5)", "warn");
		}
		// Even on failure, attempt to mount whatever we have cached (no-op if cache is empty)
		ensureMount(cfg.cacheDir, cfg.mountPoint, ctx);
		return;
	}

	// Capture HEAD SHA from the staging clone
	const shaResult = await pi.exec("git", ["-C", stagingDir, "rev-parse", "HEAD"]);
	if (shaResult.code === 0) {
		headSha = shaResult.stdout.trim();
	}

	// Atomic publish: rename existing cache aside, then promote staging to cache.
	// On any rename failure, roll back.
	try {
		if (existsSync(cfg.cacheDir)) {
			renameSync(cfg.cacheDir, oldDir);
		}
		renameSync(stagingDir, cfg.cacheDir);
	} catch (e) {
		note(ctx, `atomic cache swap failed: ${errMessage(e)}; attempting rollback`, "warn");
		// Roll back: if cacheDir is now missing but oldDir exists, restore oldDir.
		if (!existsSync(cfg.cacheDir) && existsSync(oldDir)) {
			try {
				renameSync(oldDir, cfg.cacheDir);
			} catch (e2) {
				note(ctx, `rollback failed: ${errMessage(e2)}; cache is in inconsistent state`, "error");
			}
		}
		writeState(stateFile, {
			last_sync_at: Date.now(),
			last_sync_status: "failure",
			last_sync_message: `swap failed: ${errMessage(e)}`,
			head_sha: state?.head_sha,
		});
		return;
	}

	// Successful swap. GC the old cache. Open file descriptors in concurrent
	// readers survive the directory unlink, so this is safe.
	if (existsSync(oldDir)) {
		try {
			rmSync(oldDir, { recursive: true, force: true });
		} catch (e) {
			// Non-fatal; leftover will be cleaned on next sync via cleanupStagingDirs
			note(ctx, `could not GC old cache ${oldDir}: ${errMessage(e)}`, "warn");
		}
	}

	// Mount the central skills into pi's skills dir.
	const cacheSkillsDir = join(cfg.cacheDir, "skills");
	const mounted = ensureMount(cfg.cacheDir, cfg.mountPoint, ctx);
	if (!mounted) {
		if (!existsSync(cacheSkillsDir)) {
			note(ctx, "registry has no skills/ directory yet (expected during bootstrap)", "info");
		} else {
			note(ctx, "synced but couldn't mount; central skills not visible to pi until next session", "warn");
		}
	}

	// T13.2: count skills via direct pi.exec("find", ...) — no shell, no injection
	const skillsDir = join(cfg.cacheDir, "skills");
	let skillCount = 0;
	if (existsSync(skillsDir)) {
		const countResult = await pi.exec("find", [skillsDir, "-maxdepth", "2", "-name", "SKILL.md", "-type", "f"]);
		if (countResult.code === 0) {
			skillCount = countResult.stdout
				.split("\n")
				.filter((l) => l.trim().length > 0).length;
		}
	}
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
