import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VISUAL_ARTIFACT_HELPER_SOURCE = fileURLToPath(new URL("./cursor-visual-artifact.c", import.meta.url));
let visualArtifactHelperPath;
let visualArtifactHelperDirectory;

function canonicalVisualArtifactPath(path) {
	const absolute = resolve(path);
	// macOS exposes /tmp and /var as stable system aliases to /private/tmp and
	// /private/var. Canonicalize only those OS-owned aliases so ordinary user
	// symlinked ancestors remain rejected by the anchored POSIX walk below.
	if (process.platform === "darwin") {
		for (const alias of ["/tmp", "/var"]) {
			if (absolute === alias || absolute.startsWith(`${alias}/`)) return `/private${absolute}`;
		}
	}
	return absolute;
}

function compileVisualArtifactHelper() {
	if (process.platform === "win32") {
		throw new Error("[visual-smoke] refusing artifact mutation on Windows: descriptor-relative no-follow operations are unavailable");
	}
	if (visualArtifactHelperPath) return visualArtifactHelperPath;
	const source = new Uint8Array(readFileSync(VISUAL_ARTIFACT_HELPER_SOURCE));
	const key = createHash("sha256").update(source).update(process.platform).update(process.arch).digest("hex").slice(0, 16);
	visualArtifactHelperDirectory = mkdtempSync(join(tmpdir(), `pi-cursor-visual-artifact-${key}-`));
	const output = join(visualArtifactHelperDirectory, "artifact");
	const compiled = spawnSync("cc", [
		"-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", output, VISUAL_ARTIFACT_HELPER_SOURCE,
	], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
	if (compiled.status !== 0 || compiled.error) {
		const detail = compiled.error?.message ?? compiled.stderr?.trim() ?? `exit ${compiled.status}`;
		rmSync(visualArtifactHelperDirectory, { recursive: true, force: true });
		visualArtifactHelperDirectory = undefined;
		throw new Error(`[visual-smoke] failed to compile secure artifact helper: ${detail}`);
	}
	chmodSync(output, 0o700);
	visualArtifactHelperPath = output;
	process.once("exit", () => {
		if (visualArtifactHelperDirectory) {
			try { rmSync(visualArtifactHelperDirectory, { recursive: true, force: true }); } catch {}
		}
	});
	return output;
}

function runVisualArtifactOperation(operation, path, content) {
	const helper = compileVisualArtifactHelper();
	const result = spawnSync(helper, [operation, path], {
		input: content === undefined ? undefined : Buffer.from(content),
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	if (result.status !== 0 || result.error) {
		const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
		throw new Error(`[visual-smoke] secure artifact ${operation} failed for ${path}: ${detail}`);
	}
}

/** Ensure every existing/created path component is a real directory, never a symlink. */
export function ensureVisualArtifactDirectory(directory) {
	const absolute = canonicalVisualArtifactPath(directory);
	// Windows has no Node API for handle-relative creation, so directory
	// mutation also fails closed rather than using a raceable pathname walk.
	if (process.platform === "win32") compileVisualArtifactHelper();
	runVisualArtifactOperation("ensure", absolute);
	return absolute;
}

/** Write text or binary visual evidence through anchored POSIX openat operations. */
export function writeVisualArtifactFile(path, content) {
	if (process.platform === "win32") compileVisualArtifactHelper();
	const absolute = canonicalVisualArtifactPath(path);
	ensureVisualArtifactDirectory(dirname(absolute));
	runVisualArtifactOperation("write", absolute, content);
}

/** Remove only an existing regular artifact file through an anchored POSIX unlinkat operation. */
export function removeVisualArtifactFile(path) {
	if (process.platform === "win32") compileVisualArtifactHelper();
	const absolute = canonicalVisualArtifactPath(path);
	ensureVisualArtifactDirectory(dirname(absolute));
	runVisualArtifactOperation("remove", absolute);
}

function manifestExistingPath(path) {
	try {
		const stats = lstatSync(path);
		return stats.isFile() && !stats.isSymbolicLink() ? path : undefined;
	} catch {
		return undefined;
	}
}

export function redactedArgv(argv) {
	const redacted = [];
	let redactNext = false;
	for (const arg of argv) {
		if (redactNext) {
			redacted.push("[redacted]");
			redactNext = false;
			continue;
		}
		if (arg === "--prompt" || arg === "--prompt-file") {
			redacted.push(arg);
			redactNext = true;
			continue;
		}
		if (arg.startsWith("--prompt=") || arg.startsWith("--prompt-file=")) {
			const [flag] = arg.split("=", 1);
			redacted.push(`${flag}=[redacted]`);
			continue;
		}
		redacted.push(arg);
	}
	return redacted;
}

export function promptDigest(prompt) {
	return createHash("sha256").update(prompt).digest("hex");
}

export function writeVisualManifest(path, options, artifacts, failure) {
	const paths = {
		ansi: manifestExistingPath(artifacts.ansiPath),
		text: manifestExistingPath(artifacts.textPath),
		html: manifestExistingPath(artifacts.htmlPath),
		png: artifacts.pngWritten === true ? manifestExistingPath(artifacts.pngPath) : undefined,
		jsonlPathFile: manifestExistingPath(artifacts.jsonlPathFile),
		jsonl: manifestExistingPath(artifacts.jsonlPath),
	};
	for (const [key, value] of Object.entries(paths)) {
		if (value === undefined) delete paths[key];
	}
	writeVisualArtifactFile(path, `${JSON.stringify({
		schemaVersion: 1,
		kind: "visual-tui-smoke-manifest",
		label: options.label,
		safeLabel: options.safeLabel,
		promptLength: options.prompt.length,
		promptSha256: promptDigest(options.prompt),
		width: options.width,
		height: options.height,
		model: options.model,
		mode: options.mode,
		cwd: options.cwd,
		ext: options.ext,
		outDir: options.outDir,
		sessionDir: options.sessionDir,
		sessionId: options.sessionId,
		waitMs: options.waitMs,
		startupMs: options.startupMs,
		screenshot: options.screenshot,
		paths,
		command: {
			argv: redactedArgv(process.argv.slice(2)),
			cwd: process.cwd(),
			pid: process.pid,
		},
		...(failure ? { failure } : {}),
		writtenAt: new Date().toISOString(),
	}, null, 2)}\n`);
}
