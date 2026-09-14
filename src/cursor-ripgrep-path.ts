import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

const RIPGREP_ENV = "CURSOR_RIPGREP_PATH";
const TREE_SITTER_VENDOR_ENV = "CURSOR_TREE_SITTER_VENDOR_DIR";

function resolveCursorSdkPlatformPackageDirectory(fromModuleUrl: string | URL): string {
	const require = createRequire(fromModuleUrl);
	const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
	const sdkEntry = require.resolve("@cursor/sdk");
	return dirname(require.resolve(`${platformPackage}/package.json`, { paths: [dirname(sdkEntry)] }));
}

function ensureEnvAbsoluteOrBundled(envName: string, bundledPath: string | undefined): string | undefined {
	const configuredPath = process.env[envName];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;
	if (bundledPath) process.env[envName] = bundledPath;
	return bundledPath;
}

/** Bundled `@cursor/sdk-<platform>-<arch>/bin/rg` (or `rg.exe` on Windows). */
export function resolveBundledCursorRipgrepPath(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const ripgrepPath = join(
			resolveCursorSdkPlatformPackageDirectory(fromModuleUrl),
			"bin",
			process.platform === "win32" ? "rg.exe" : "rg",
		);
		accessSync(ripgrepPath, constants.X_OK);
		return ripgrepPath;
	} catch {
		return undefined;
	}
}

export function ensureCursorRipgrepPath(): string | undefined {
	return ensureEnvAbsoluteOrBundled(RIPGREP_ENV, resolveBundledCursorRipgrepPath());
}

/**
 * Bundled platform-package `vendor/` directory that contains `tree-sitter/index.js`.
 * `@cursor/sdk` loads this from `CURSOR_TREE_SITTER_VENDOR_DIR` and does not search
 * the process cwd for those natives.
 */
export function resolveBundledCursorTreeSitterVendorDir(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const vendorDir = join(resolveCursorSdkPlatformPackageDirectory(fromModuleUrl), "vendor");
		accessSync(join(vendorDir, "tree-sitter", "index.js"), constants.R_OK);
		return vendorDir;
	} catch {
		return undefined;
	}
}

/** Set `CURSOR_TREE_SITTER_VENDOR_DIR` to the bundled vendor dir unless an absolute override is already set. */
export function ensureCursorTreeSitterVendorDir(): string | undefined {
	return ensureEnvAbsoluteOrBundled(TREE_SITTER_VENDOR_ENV, resolveBundledCursorTreeSitterVendorDir());
}
