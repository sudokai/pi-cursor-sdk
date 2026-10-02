import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

const RIPGREP_ENV = "CURSOR_RIPGREP_PATH";
const TREE_SITTER_VENDOR_ENV = "CURSOR_TREE_SITTER_VENDOR_DIR";

function ensureEnvAbsoluteOrBundled(envName: string, bundledPath: string | undefined): string | undefined {
	const configuredPath = process.env[envName];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;
	if (bundledPath) process.env[envName] = bundledPath;
	return bundledPath;
}

/** Resolve the native platform package relative to the installed SDK, not the host launcher. */
export function resolveCursorSdkPlatformPackageDirectory(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const require = createRequire(fromModuleUrl);
		const sdkEntry = require.resolve("@cursor/sdk");
		return dirname(require.resolve(`@cursor/sdk-${process.platform}-${process.arch}/package.json`, {
			paths: [dirname(sdkEntry)],
		}));
	} catch {
		return undefined;
	}
}

/** Resolve bundled ripgrep only when the platform executable is accessible. */
export function resolveBundledCursorRipgrepPath(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	const packageDirectory = resolveCursorSdkPlatformPackageDirectory(fromModuleUrl);
	if (!packageDirectory) return undefined;
	try {
		const ripgrepPath = join(packageDirectory, "bin", process.platform === "win32" ? "rg.exe" : "rg");
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
 * Bundled platform-package `vendor/` directory containing both tree-sitter parser entrypoints.
 * `@cursor/sdk` loads this from `CURSOR_TREE_SITTER_VENDOR_DIR` and does not search
 * the process cwd for those natives.
 */
export function resolveBundledCursorTreeSitterVendorDir(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	const packageDirectory = resolveCursorSdkPlatformPackageDirectory(fromModuleUrl);
	if (!packageDirectory) return undefined;
	try {
		const vendorDir = join(packageDirectory, "vendor");
		accessSync(join(vendorDir, "tree-sitter", "index.js"), constants.R_OK);
		accessSync(join(vendorDir, "tree-sitter-bash", "index.js"), constants.R_OK);
		return vendorDir;
	} catch {
		return undefined;
	}
}

/** Set `CURSOR_TREE_SITTER_VENDOR_DIR` to the bundled vendor dir unless an absolute override is already set. */
export function ensureCursorTreeSitterVendorDir(): string | undefined {
	return ensureEnvAbsoluteOrBundled(TREE_SITTER_VENDOR_ENV, resolveBundledCursorTreeSitterVendorDir());
}
