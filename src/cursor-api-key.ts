import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
const CURSOR_PROVIDER_ID = "cursor";
const PRIME_AGENT_CONFIG_DIR_NAME = ".prime/agent";

// Non-secret literal sentinel for pi's provider registry. Pi 0.77 treats `$ENV_VAR`
// values as unconfigured when the env var is absent, which hides fallback models
// before `/login`. Keep the provider available and resolve the real key in the
// Cursor provider turn path from pi auth or CURSOR_API_KEY.
export const CURSOR_API_KEY_CONFIG_VALUE = "pi-cursor-sdk-cursor-api-key-placeholder";

const CURSOR_API_KEY_PLACEHOLDERS = new Set([
	CURSOR_API_KEY_ENV_VAR,
	`$${CURSOR_API_KEY_ENV_VAR}`,
	`\${${CURSOR_API_KEY_ENV_VAR}}`,
	CURSOR_API_KEY_CONFIG_VALUE,
]);

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (CURSOR_API_KEY_PLACEHOLDERS.has(trimmed)) return process.env.CURSOR_API_KEY?.trim() || undefined;
	return trimmed;
}

// pi exposes readStoredCredential; prime-agent drops it but ships AuthStorage.
// Both resolve to the same {type,key} credential shape, so try pi's helper first
// and fall back to prime-agent's storage when the helper is absent.
type StoredApiKeyCredential = { type: "api_key"; key: string };
type StoredCredential = StoredApiKeyCredential | { type: "oauth" };
type AuthStorageLike = {
	create?: (authPath?: string) => { get?: (provider: string) => StoredCredential | undefined } | undefined;
};
type PiCodingAgentAuthModule = {
	readStoredCredential?: (providerId: string, authPath?: string) => StoredCredential | undefined;
	AuthStorage?: AuthStorageLike;
	getAgentDir?: () => string;
};

function resolveStoredCursorApiKeyFromCredential(credential: StoredCredential | undefined): string | undefined {
	return resolveCursorApiKey(credential?.type === "api_key" ? credential.key : undefined);
}

function readStoredCredentialFromAuth(auth: PiCodingAgentAuthModule, authPath: string): StoredCredential | undefined {
	if (typeof auth.readStoredCredential === "function") {
		return auth.readStoredCredential(CURSOR_PROVIDER_ID, authPath);
	}
	return auth.AuthStorage?.create?.(authPath)?.get?.(CURSOR_PROVIDER_ID);
}

function userHomeDir(): string {
	const home = process.env.HOME?.trim();
	if (home) return home;
	const userProfile = process.env.USERPROFILE?.trim();
	if (userProfile) return userProfile;
	return homedir();
}

function storedCursorAuthPaths(primaryAuthPath: string): string[] {
	const paths = [primaryAuthPath];
	const primeAuthPath = join(userHomeDir(), PRIME_AGENT_CONFIG_DIR_NAME, "auth.json");
	if (primeAuthPath !== primaryAuthPath) paths.push(primeAuthPath);
	return paths;
}

async function getStoredCursorApiKey(): Promise<string | undefined> {
	try {
		const mod = await import("@earendil-works/pi-coding-agent");
		const auth = mod as typeof mod & PiCodingAgentAuthModule;
		const primaryAuthPath = join(typeof auth.getAgentDir === "function" ? auth.getAgentDir() : getAgentDir(), "auth.json");
		for (const authPath of storedCursorAuthPaths(primaryAuthPath)) {
			if (!existsSync(authPath)) continue;
			const resolved = resolveStoredCursorApiKeyFromCredential(readStoredCredentialFromAuth(auth, authPath));
			if (resolved) return resolved;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export async function resolveCursorRuntimeApiKey(): Promise<string | undefined> {
	return (await getStoredCursorApiKey()) ?? resolveCursorApiKey(process.env.CURSOR_API_KEY);
}
