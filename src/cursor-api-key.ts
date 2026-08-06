export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
const CURSOR_PROVIDER_ID = "cursor";

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
type AuthStorageLike = {
	create?: (authPath?: string) => { get?: (provider: string) => StoredApiKeyCredential | { type: "oauth" } | undefined } | undefined;
};

async function getStoredCursorApiKey(): Promise<string | undefined> {
	try {
		const mod = await import("@earendil-works/pi-coding-agent");
		const auth = mod as typeof mod & { AuthStorage?: AuthStorageLike };
		const credential =
			typeof auth.readStoredCredential === "function"
				? auth.readStoredCredential(CURSOR_PROVIDER_ID)
				: auth.AuthStorage?.create?.()?.get?.(CURSOR_PROVIDER_ID);
		return resolveCursorApiKey(credential?.type === "api_key" ? credential.key : undefined);
	} catch {
		return undefined;
	}
}

export async function resolveCursorRuntimeApiKey(): Promise<string | undefined> {
	return (await getStoredCursorApiKey()) ?? resolveCursorApiKey(process.env.CURSOR_API_KEY);
}
