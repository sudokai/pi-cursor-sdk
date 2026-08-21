import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const originalRename = fsPromises.rename;
const originalRm = fsPromises.rm;

const faults = {
	"stale-rm"() {
		fsPromises.rm = async (path, options) => {
			if (basename(String(path)) === process.env.LOCKED_STAGING_NAME) {
				throw new Error("synthetic stale-staging lock");
			}
			return originalRm(path, options);
		};
	},
	"late-winner"() {
		let firstRename = true;
		fsPromises.rename = async (...args) => {
			if (!basename(String(args[0])).startsWith("dist.staging.")) return originalRename(...args);
			if (!firstRename) return originalRename(...args);
			firstRename = false;
			// The ref'd timer keeps the child alive so its marker proves publication
			// happened after the old two-second poll window.
			setTimeout(() => {
				fs.mkdirSync(join(process.cwd(), "dist"), { recursive: true });
				fs.writeFileSync(join(process.cwd(), "dist", "index.js"), "winner");
				fs.writeFileSync(join(process.cwd(), "dist", "late-winner.txt"), "published");
			}, 2_200);
			throw new Error("synthetic late-winner race");
		};
	},
	"race-loss"() {
		fsPromises.rename = async (...args) => {
			if (!basename(String(args[0])).startsWith("dist.staging.")) return originalRename(...args);
			const cwd = process.cwd();
			const dist = join(cwd, "dist");
			fs.mkdirSync(dist, { recursive: true });
			fs.writeFileSync(join(dist, "winner.txt"), "published");
			fs.writeFileSync(join(dist, "index.js"), "winner");
			// Shared fixture: only pi-mcp-adapter supplies dist-relative runtime assets.
			for (const asset of (process.env.BUILD_SWAP_RUNTIME_ASSETS ?? "").split(",").filter(Boolean)) {
				fs.copyFileSync(join(cwd, asset), join(dist, asset));
			}
			throw new Error("synthetic race loss");
		};
	},
	"rename-always"() {
		fsPromises.rename = async () => {
			throw new Error("synthetic permanent rename failure");
		};
	},
	"previous-rename-fails"() {
		fsPromises.rename = async (source, target) => {
			if (basename(String(source)) === "dist") throw new Error("synthetic previous-dist move failure");
			return originalRename(source, target);
		};
	},
	"interrupt-after-backup"() {
		fsPromises.rename = async (source, target) => {
			const result = await originalRename(source, target);
			if (basename(String(source)) === "dist") {
				process.kill(process.pid, "SIGTERM");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			return result;
		};
	},
	"publish-rename-always"() {
		fsPromises.rename = async (source, target) => {
			if (basename(String(source)).startsWith("dist.staging.")) throw new Error("synthetic permanent publish failure");
			return originalRename(source, target);
		};
	},
	"vanish-staging"() {
		fsPromises.rename = async (...args) => {
			if (!basename(String(args[0])).startsWith("dist.staging.")) return originalRename(...args);
			await originalRm(args[0], { force: true, recursive: true });
			return originalRename(...args);
		};
	},
	"empty-dist"() {
		let firstRename = true;
		fsPromises.rename = async (...args) => {
			if (!basename(String(args[0])).startsWith("dist.staging.")) return originalRename(...args);
			const dist = join(process.cwd(), "dist");
			if (firstRename) {
				firstRename = false;
				fs.mkdirSync(dist, { recursive: true });
				throw new Error("synthetic empty dist");
			}
			fs.rmSync(dist, { recursive: true, force: true });
			return originalRename(...args);
		};
	},
	"incomplete-dist"() {
		fsPromises.rename = async (...args) => {
			if (!basename(String(args[0])).startsWith("dist.staging.")) return originalRename(...args);
			const dist = join(process.cwd(), "dist");
			fs.mkdirSync(dist, { recursive: true });
			fs.writeFileSync(join(dist, "partial.js"), "incomplete");
			throw new Error("synthetic incomplete dist");
		};
	},
};

const faultName = process.env.BUILD_SWAP_FAULT;
if (faultName && !Object.hasOwn(faults, faultName)) throw new Error(`unknown build-swap fault: ${faultName}`);
faults[faultName]?.();
syncBuiltinESMExports();
