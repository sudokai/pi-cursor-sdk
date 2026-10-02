import { resolveBundledCursorTreeSitterVendorDir } from "./cursor-ripgrep-path.js";

export type CursorSdkModule = typeof import("@cursor/sdk");

export async function loadCursorSdk(): Promise<CursorSdkModule> {
	// The SDK searches launcher ancestors, which miss Pi's separately installed extension packages.
	if (process.env.CURSOR_TREE_SITTER_VENDOR_DIR === undefined) {
		const vendorDir = resolveBundledCursorTreeSitterVendorDir();
		if (vendorDir) process.env.CURSOR_TREE_SITTER_VENDOR_DIR = vendorDir;
	}
	return import("@cursor/sdk");
}
