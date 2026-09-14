import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.27", main: "index.js" }));
	writeFileSync(join(sdkDir, "index.js"), "module.exports = {};\n");
	writeFileSync(join(nestedPlatformDir, "package.json"), JSON.stringify({ name: platformPackage, version: "1.0.27" }));
	writeFileSync(consumerModule, "export {};\n");
	return { root, consumerModule, nestedPlatformDir };
}

function installedCursorSdkRoot(): string {
	const require = createRequire(import.meta.url);
	return join(dirname(require.resolve("@cursor/sdk")), "..", "..");
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

	it("locks installed @cursor/sdk 1.0.27 Agent.create ripgrep contract", () => {
		const sdkRoot = installedCursorSdkRoot();
		const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { version: string };
		expect(sdkPackage.version).toBe("1.0.27");

		const bundle = readFileSync(join(sdkRoot, "dist", "esm", "357.js"), "utf8");
		expect(bundle).toContain(
			"CURSOR_RIPGREP_PATH;O=z&&(0,a.isAbsolute)(z)?z:(0,N.hQ)({binaryName:B,excludedWorkspaceDir:E}),O||(O=(0,P.resolveRipgrepFromPath)()),O&&(0,P.configureRipgrepPath)(O)",
		);
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

			expect(resolveBundledCursorTreeSitterVendorDir(pathToFileURL(consumerModule))).toBe(
				realpathSync(join(nestedPlatformDir, "vendor")),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("locks installed @cursor/sdk 1.0.27 tree-sitter vendor env and shell-parser warn", () => {
		const sdkRoot = installedCursorSdkRoot();
		const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { version: string };
		expect(sdkPackage.version).toBe("1.0.27");

		expect(readFileSync(join(sdkRoot, "dist", "esm", "index.js"), "utf8")).toContain("CURSOR_TREE_SITTER_VENDOR_DIR");
		expect(readFileSync(join(sdkRoot, "dist", "esm", "357.js"), "utf8")).toContain(
			"shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed",
		);
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
