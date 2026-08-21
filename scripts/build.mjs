#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Run TypeScript emit into a staging directory, then transactionally publish it
 * into dist/ so a failed emit or publication never destroys a previously working dist.
 * Usage: `npm run build`; also invoked by scripts/prepare.mjs during install lifecycles.
 * Invariants/Assumptions: `node_modules` provides `typescript`; publication preserves the prior generated tree until the staged tree is installed.
 */

import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const RM_OPTIONS = { force: true, maxRetries: 5, recursive: true, retryDelay: 100 };
const RENAME_RETRY_LIMIT = 50;
const RENAME_RETRY_MS = 50;
const BACKUP_DIRECTORY_PATTERN = /^dist\.backup\.(\d+)$/;
const PUBLISH_LOCK_DIRECTORY = "dist.publish.lock";
const PUBLISH_LOCK_RETRY_LIMIT = 100;
const PUBLISH_LOCK_STALE_MS = 5_000;
// Run tsc's JS entrypoint directly through the current node binary: no .cmd shim,
// no shell, safe for install paths containing spaces on every platform.
const tscPath = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
let interruptedBuildSignal;

function installBuildInterruptHandlers() {
	const onSignal = (signal) => {
		interruptedBuildSignal ??= signal;
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	return () => {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	};
}

function throwIfBuildInterrupted() {
	if (!interruptedBuildSignal) return;
	const error = new Error(`build interrupted by ${interruptedBuildSignal}`);
	error.code = "EINTR";
	throw error;
}

async function discardTree(path, kind) {
	try {
		await rm(path, RM_OPTIONS);
	} catch (error) {
		// Cleanup is always best-effort: it must not turn a successful race loss
		// into failure or replace the compiler/publish error that matters.
		console.warn(`could not remove ${kind} ${path}: ${error?.message ?? error}`);
	}
}

async function discardStaging(path) {
	return discardTree(path, "staging");
}

function isOwnerGone(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error?.code === "ESRCH";
	}
}

/**
 * A non-empty destination is not proof that a concurrent build published
 * successfully: a failed publisher can leave a partial tree behind. The
 * manifest loads dist/index.js, so only a regular entry file is a known
 * complete published winner for this swap protocol.
 */
async function isCompletePublishedDist(path) {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.some((entry) => entry.name === "index.js" && entry.isFile());
	} catch {
		return false;
	}
}

async function reapStrandedStaging(cwd) {
	// Signal 0 proves only that the owner was gone at probe time. Pid reuse
	// between this probe and removal is inherent to pid-based reaping.
	for (const entry of await readdir(cwd, { withFileTypes: true })) {
		const match = /^dist\.staging\.(\d+)$/.exec(entry.name);
		if (!match || !entry.isDirectory()) continue;
		const ownerPid = Number(match[1]);
		if (ownerPid === process.pid || !isOwnerGone(ownerPid)) continue;
		await discardStaging(join(cwd, entry.name));
	}
}

async function reclaimDeadPublishLock(lockPath) {
	let ownerPid;
	let lockAgeMs = 0;
	try {
		ownerPid = Number.parseInt((await readFile(join(lockPath, "pid"), "utf8")).trim(), 10);
	} catch {
		try {
			lockAgeMs = Date.now() - (await stat(lockPath)).mtimeMs;
		} catch {
			return true;
		}
	}
	if (ownerPid && !isOwnerGone(ownerPid)) return false;
	if (!ownerPid && lockAgeMs < PUBLISH_LOCK_STALE_MS) return false;
	const reclaimPath = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`;
	try {
		await rename(lockPath, reclaimPath);
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
	await rm(reclaimPath, RM_OPTIONS);
	return true;
}

async function acquirePublishLock(cwd) {
	const lockPath = join(cwd, PUBLISH_LOCK_DIRECTORY);
	const ownerPath = `${lockPath}.owner.${process.pid}.${randomUUID()}`;
	await mkdir(ownerPath);
	await writeFile(join(ownerPath, "pid"), `${process.pid}\n`, "utf8");
	for (let retry = 0; retry <= PUBLISH_LOCK_RETRY_LIMIT; retry += 1) {
		try {
			// The owner directory is fully written before this atomic rename. A
			// crash cannot leave an ownerless lock at the published lock path.
			await rename(ownerPath, lockPath);
			return async () => { await rm(lockPath, RM_OPTIONS); };
		} catch (error) {
			if (error?.code !== "EEXIST" && error?.code !== "EPERM" && error?.code !== "ENOTEMPTY") {
				await rm(ownerPath, RM_OPTIONS);
				throw error;
			}
			if (await reclaimDeadPublishLock(lockPath)) continue;
			if (retry === PUBLISH_LOCK_RETRY_LIMIT) {
				await rm(ownerPath, RM_OPTIONS);
				throw new Error(`timed out waiting for ${PUBLISH_LOCK_DIRECTORY}`);
			}
			await delay(RENAME_RETRY_MS);
		}
	}
	await rm(ownerPath, RM_OPTIONS);
	throw new Error(`timed out waiting for ${PUBLISH_LOCK_DIRECTORY}`);
}

async function recoverStrandedBackups(cwd) {
	// A process can be interrupted after moving dist aside but before the staged
	// tree is published. Recover a dead owner's old tree before any new build can
	// mistake the missing dist for an empty installation.
	for (const entry of await readdir(cwd, { withFileTypes: true })) {
		const match = BACKUP_DIRECTORY_PATTERN.exec(entry.name);
		if (!match || !entry.isDirectory()) continue;
		const ownerPid = Number(match[1]);
		if (ownerPid === process.pid || !isOwnerGone(ownerPid)) continue;
		const backupDir = join(cwd, entry.name);
		const distDir = join(cwd, "dist");
		try {
			if (await isCompletePublishedDist(distDir)) {
				await discardTree(backupDir, "backup");
				continue;
			}
			if (existsSync(distDir)) await rm(distDir, RM_OPTIONS);
			await rename(backupDir, distDir);
		} catch (error) {
			if (await isCompletePublishedDist(distDir)) {
				await discardTree(backupDir, "backup");
			} else {
				console.warn(`could not recover backup ${backupDir}: ${error?.message ?? error}`);
			}
		}
	}
}

async function recoverOwnedBackup(backupDir, distDir) {
	if (!existsSync(backupDir)) return;
	if (await isCompletePublishedDist(distDir)) {
		await discardTree(backupDir, "backup");
		return;
	}
	if (existsSync(distDir)) await rm(distDir, RM_OPTIONS);
	await rename(backupDir, distDir);
}

async function compileToStaging(cwd, stagingDir) {
	try {
		const { stderr, stdout } = await execFile(
			process.execPath,
			[tscPath, "-p", "tsconfig.build.json", "--outDir", stagingDir],
			{ cwd, maxBuffer: 10 * 1024 * 1024 },
		);
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	} catch (error) {
		if (error?.stdout) process.stdout.write(error.stdout);
		if (error?.stderr) process.stderr.write(error.stderr);
		await discardStaging(stagingDir);
		throw error;
	}
}

async function movePreviousDistToBackup(distDir, backupDir) {
	try {
		await rename(distDir, backupDir);
		return true;
	} catch (error) {
		// Another build may have moved or published dist between our probe and
		// rename. ENOENT means this publisher no longer owns the old source;
		// proceeding lets the winner be observed by the staged rename below.
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function restorePreviousDist(backupDir, distDir) {
	if (!existsSync(backupDir)) return false;
	if (await isCompletePublishedDist(distDir)) return false;
	if (existsSync(distDir)) await rm(distDir, RM_OPTIONS);
	await rename(backupDir, distDir);
	return true;
}

async function publishStaging(stagingDir, distDir) {
	const backupDir = `${distDir}.backup.${process.pid}`;
	let previousMoved = false;
	let published = false;
	let concurrentWinner = false;
	try {
		// A prior interrupted run owned by this pid cannot still be live. Recover
		// it before replacing anything, then reserve the old dist with rename rather
		// than deleting it. This keeps rollback possible on every publish failure.
		await recoverOwnedBackup(backupDir, distDir);
		await rm(backupDir, RM_OPTIONS);
		previousMoved = await movePreviousDistToBackup(distDir, backupDir);
		for (let retry = 0; ; retry++) {
			throwIfBuildInterrupted();
			let renamed = false;
			try {
				await rename(stagingDir, distDir);
				renamed = true;
			} catch (error) {
				// Only the package entry file proves that a concurrent publisher
				// installed a complete tree. Incomplete or empty destinations must
				// remain rollback candidates.
				if (await isCompletePublishedDist(distDir)) {
					concurrentWinner = true;
					console.warn("dist/ was published by a concurrent build; discarding this build's staging tree.");
					break;
				}
				// At most 50 retries (~2.5s) keep persistent filesystem errors bounded.
				if (existsSync(stagingDir) && retry < RENAME_RETRY_LIMIT) {
					await delay(RENAME_RETRY_MS);
					continue;
				}
				throw error;
			}
			if (renamed) {
				published = true;
				throwIfBuildInterrupted();
				break;
			}
		}
	} catch (error) {
		if (previousMoved && !published && !concurrentWinner) {
			try {
				if (await restorePreviousDist(backupDir, distDir)) previousMoved = false;
			} catch (restoreError) {
				console.error(`could not restore previous dist ${distDir}: ${restoreError?.message ?? restoreError}`);
			}
		}
		throw error;
	} finally {
		// Safe after success too: rename moved stagingDir, so force makes this a no-op.
		await discardStaging(stagingDir);
		if ((published || concurrentWinner) && previousMoved) await discardTree(backupDir, "backup");
	}
}

async function main() {
	const cwd = process.cwd();
	if (!existsSync(tscPath)) throw new Error(`typescript is not installed at ${tscPath}; run npm install first.`);
	await reapStrandedStaging(cwd);
	const releasePublishLock = await acquirePublishLock(cwd);
	try {
		await recoverStrandedBackups(cwd);
		// Pid-scoped staging isolates concurrent emits; only a complete tree publishes.
		const stagingDir = join(cwd, `dist.staging.${process.pid}`);
		await rm(stagingDir, RM_OPTIONS);
		await compileToStaging(cwd, stagingDir);
		const removeInterruptHandlers = installBuildInterruptHandlers();
		try {
			throwIfBuildInterrupted();
			await publishStaging(stagingDir, join(cwd, "dist"));
		} finally {
			removeInterruptHandlers();
		}
	} finally {
		await releasePublishLock();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
