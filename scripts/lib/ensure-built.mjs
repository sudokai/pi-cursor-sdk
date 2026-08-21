/**
 * Rebuild dist/ before a launcher loads the repo-root extension, so direct
 * `node scripts/<launcher>.mjs` invocations can never exercise stale code.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSC_PATH = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const RUNTIME_ENTRY = join(REPO_ROOT, "dist", "index.js");

export function ensureBuilt() {
	// npm-packed runtime installs intentionally omit devDependencies. They already
	// contain dist/, so direct smoke/debug launchers must not try to compile again.
	if (!existsSync(TSC_PATH)) {
		if (existsSync(RUNTIME_ENTRY)) return;
		throw new Error(`typescript is not installed at ${TSC_PATH} and no built runtime exists at ${RUNTIME_ENTRY}`);
	}
	execFileSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url))], {
		// build.mjs anchors tsc/dist/staging to its cwd; pin it to the repo root so
		// direct launcher invocations work from any directory.
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureBuilt();
