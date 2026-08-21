export function ensureVisualArtifactDirectory(directory: string): string;
export function removeVisualArtifactFile(path: string): void;
export function writeVisualArtifactFile(path: string, content: string | Uint8Array): void;
export function redactedArgv(argv: string[]): string[];
export function promptDigest(prompt: string): string;
export function writeVisualManifest(path: string, options: Record<string, unknown>, artifacts: Record<string, unknown>, failure?: Record<string, unknown>): void;
