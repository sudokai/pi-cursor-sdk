import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureCursorRipgrepPath,
	ensureCursorTreeSitterVendorDir,
	resolveBundledCursorRipgrepPath,
	resolveBundledCursorTreeSitterVendorDir,
} from "../src/cursor-ripgrep-path.js";
import { readInstalledPackageDistText } from "./helpers/installed-package.js";

const originalRipgrepPath = process.env.CURSOR_RIPGREP_PATH;
const originalTreeSitterVendorDir = process.env.CURSOR_TREE_SITTER_VENDOR_DIR;
const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
const rgBinaryName = process.platform === "win32" ? "rg.exe" : "rg";

afterEach(() => {
	if (originalRipgrepPath === undefined) delete process.env.CURSOR_RIPGREP_PATH;
	else process.env.CURSOR_RIPGREP_PATH = originalRipgrepPath;
	if (originalTreeSitterVendorDir === undefined) delete process.env.CURSOR_TREE_SITTER_VENDOR_DIR;
	else process.env.CURSOR_TREE_SITTER_VENDOR_DIR = originalTreeSitterVendorDir;
});

function createNestedCursorSdkPlatformPackage(prefix: string): {
	root: string;
	consumerModule: string;
	nestedPlatformDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const consumerDir = join(root, "consumer");
	const consumerModule = join(consumerDir, "index.js");
	const sdkDir = join(consumerDir, "node_modules", "@cursor", "sdk");
	const nestedPlatformDir = join(sdkDir, "node_modules", "@cursor", `sdk-${process.platform}-${process.arch}`);
	mkdirSync(nestedPlatformDir, { recursive: true });
	writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.32", main: "index.js" }));
	writeFileSync(join(sdkDir, "index.js"), "module.exports = {};\n");
	writeFileSync(join(nestedPlatformDir, "package.json"), JSON.stringify({ name: platformPackage, version: "1.0.32" }));
	writeFileSync(consumerModule, "export {};\n");
	return { root, consumerModule, nestedPlatformDir };
}


describe("Cursor ripgrep path", () => {
	it("resolves the executable from the installed Cursor SDK platform package", () => {
		const ripgrepPath = resolveBundledCursorRipgrepPath();

		if (!ripgrepPath) throw new Error("Expected the installed Cursor SDK platform package to include ripgrep");
		expect(ripgrepPath.replaceAll("\\", "/")).toContain(platformPackage);
		expect(() => accessSync(ripgrepPath, constants.X_OK)).not.toThrow();
	});

	it("resolves a platform package nested under @cursor/sdk/node_modules", () => {
		const { root, consumerModule, nestedPlatformDir } = createNestedCursorSdkPlatformPackage("pi-cursor-ripgrep-nested-");
		try {
			const nestedBinDir = join(nestedPlatformDir, "bin");
			const nestedRg = join(nestedBinDir, rgBinaryName);
			mkdirSync(nestedBinDir, { recursive: true });

			writeFileSync(nestedRg, "#!/bin/sh\nexit 0\n");
			chmodSync(nestedRg, 0o755);

			const consumerRequire = createRequire(consumerModule);
			expect(() => consumerRequire.resolve(`${platformPackage}/package.json`)).toThrow();
			expect(consumerRequire.resolve("@cursor/sdk")).toBe(realpathSync(join(dirname(consumerModule), "node_modules", "@cursor", "sdk", "index.js")));

			expect(resolveBundledCursorRipgrepPath(pathToFileURL(consumerModule))).toBe(realpathSync(nestedRg));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("locks the installed SDK Agent.create ripgrep contract", () => {
		const bundle = readInstalledPackageDistText("@cursor/sdk");

		// Absolute CURSOR_RIPGREP_PATH wins; otherwise platform-package lookup, then PATH, then configure.
		expect(bundle).toContain("CURSOR_RIPGREP_PATH");
		expect(bundle).toContain("resolveRipgrepFromPath");
		expect(bundle).toContain("excludedWorkspaceDir");
		expect(bundle).toContain('throw new Error("configureRipgrepPath: path must not be empty")');
		expect(bundle).toContain("Ripgrep path not configured. Call configureRipgrepPath() at startup.");
	});

	it("configures an empty path without overriding an existing absolute value", () => {
		process.env.CURSOR_RIPGREP_PATH = "";
		const bundledPath = ensureCursorRipgrepPath();
		expect(process.env.CURSOR_RIPGREP_PATH).toBe(bundledPath);

		process.env.CURSOR_RIPGREP_PATH = "/custom/rg";
		expect(ensureCursorRipgrepPath()).toBe("/custom/rg");
		expect(process.env.CURSOR_RIPGREP_PATH).toBe("/custom/rg");
	});
});

describe("Cursor tree-sitter vendor dir", () => {
	it("resolves vendor/tree-sitter from the installed Cursor SDK platform package", () => {
		const vendorDir = resolveBundledCursorTreeSitterVendorDir();

		if (!vendorDir) throw new Error("Expected the installed Cursor SDK platform package to vendor tree-sitter");
		expect(vendorDir.replaceAll("\\", "/")).toContain(`${platformPackage.replaceAll("\\", "/")}/vendor`);
		expect(() => accessSync(join(vendorDir, "tree-sitter", "index.js"), constants.R_OK)).not.toThrow();
	});

	it("resolves a nested platform-package vendor directory", () => {
		const { root, consumerModule, nestedPlatformDir } = createNestedCursorSdkPlatformPackage("pi-cursor-tree-sitter-nested-");
		try {
			const nestedVendorTreeSitter = join(nestedPlatformDir, "vendor", "tree-sitter");
			mkdirSync(nestedVendorTreeSitter, { recursive: true });
			writeFileSync(join(nestedVendorTreeSitter, "index.js"), "module.exports = {};\n");
			expect(resolveBundledCursorTreeSitterVendorDir(pathToFileURL(consumerModule))).toBeUndefined();
			const nestedVendorBash = join(nestedPlatformDir, "vendor", "tree-sitter-bash");
			mkdirSync(nestedVendorBash);
			writeFileSync(join(nestedVendorBash, "index.js"), "module.exports = {};\n");

			expect(resolveBundledCursorTreeSitterVendorDir(pathToFileURL(consumerModule))).toBe(
				realpathSync(join(nestedPlatformDir, "vendor")),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("locks installed @cursor/sdk tree-sitter vendor env and shell-parser warning", () => {
		const bundle = readInstalledPackageDistText("@cursor/sdk");
		expect(bundle).toContain("CURSOR_TREE_SITTER_VENDOR_DIR");
		expect(bundle).toContain("shell-parser: tree-sitter natives are unavailable in this artifact");
	});

	it("configures an empty path without overriding an existing absolute value", () => {
		process.env.CURSOR_TREE_SITTER_VENDOR_DIR = "";
		const bundledDir = ensureCursorTreeSitterVendorDir();
		expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe(bundledDir);

		process.env.CURSOR_TREE_SITTER_VENDOR_DIR = "/custom/vendor";
		expect(ensureCursorTreeSitterVendorDir()).toBe("/custom/vendor");
		expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe("/custom/vendor");
	});
});
