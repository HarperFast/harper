import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Source = string | Buffer;

const RESOLUTION_EXTENSIONS = ['', '.js', '.json', '.node', '.ts', '.tsx', '.cjs', '.mjs'];

export class RuntimeModuleTracker {
	#getRoot: () => string | undefined;
	#modules = new Map<string, string>();
	#resolutions = new Map<string, string>();
	#nativeRuntime = false;
	#deployInFlight = false;
	#loadedDuringDeploy = false;
	#comparison?: Promise<boolean>;

	constructor(getRoot: () => string | undefined) {
		this.#getRoot = getRoot;
	}

	beginDeploy(): void {
		if (this.#deployInFlight) return;
		this.#deployInFlight = true;
		this.#loadedDuringDeploy = false;
		this.#comparison = undefined;
	}

	markNativeRuntime(): void {
		this.#nativeRuntime = true;
		if (this.#deployInFlight) this.#loadedDuringDeploy = true;
	}

	recordModule(moduleUrl: string, source: Source): void {
		const modulePath = this.#localPath(moduleUrl);
		if (!modulePath) return;
		if (!this.#modules.has(modulePath)) this.#modules.set(modulePath, digest(source));
		if (this.#deployInFlight) this.#loadedDuringDeploy = true;
	}

	recordResolution(specifier: string, referrer: string, resolvedUrl: string): void {
		if (!specifier.startsWith('.')) return;
		const referrerPath = this.#localPath(referrer);
		if (!referrerPath || !this.#localPath(resolvedUrl)) return;
		const key = `${referrerPath}\0${specifier}`;
		if (!this.#resolutions.has(key)) this.#resolutions.set(key, resolutionFingerprint(specifier, referrerPath));
		if (this.#deployInFlight) this.#loadedDuringDeploy = true;
	}

	finishDeploy(): Promise<boolean> {
		if (!this.#deployInFlight) return this.#comparison ?? Promise.resolve(false);
		this.#deployInFlight = false;
		this.#comparison = this.#compare();
		return this.#comparison;
	}

	async #compare(): Promise<boolean> {
		if (this.#nativeRuntime || this.#loadedDuringDeploy) return true;
		for (const [modulePath, previousDigest] of this.#modules) {
			try {
				if (digest(await readFile(modulePath)) !== previousDigest) return true;
			} catch {
				return true;
			}
		}
		for (const [key, previousFingerprint] of this.#resolutions) {
			const separator = key.indexOf('\0');
			const referrerPath = key.slice(0, separator);
			const specifier = key.slice(separator + 1);
			if ((await resolutionFingerprintAsync(specifier, referrerPath)) !== previousFingerprint) return true;
		}
		return false;
	}

	#localPath(moduleUrl: string): string | undefined {
		if (!moduleUrl.startsWith('file:')) return;
		const root = this.#getRoot();
		if (!root) return;
		const modulePath = fileURLToPath(moduleUrl);
		const relativePath = relative(resolve(root), modulePath);
		if (
			relativePath === '' ||
			(!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
		)
			return modulePath;
	}
}

function resolutionFingerprint(specifier: string, referrerPath: string): string {
	return JSON.stringify(
		resolutionCandidates(specifier, referrerPath).map((candidate) => [candidate, candidateState(candidate)])
	);
}

async function resolutionFingerprintAsync(specifier: string, referrerPath: string): Promise<string> {
	return JSON.stringify(
		await Promise.all(
			resolutionCandidates(specifier, referrerPath).map(async (candidate) => [
				candidate,
				await candidateStateAsync(candidate),
			])
		)
	);
}

function resolutionCandidates(specifier: string, referrerPath: string): string[] {
	const basePath = resolve(dirname(referrerPath), specifier);
	const candidates = new Set<string>();
	for (const extension of RESOLUTION_EXTENSIONS) candidates.add(basePath + extension);
	candidates.add(resolve(basePath, 'package.json'));
	for (const extension of RESOLUTION_EXTENSIONS.slice(1)) candidates.add(resolve(basePath, `index${extension}`));
	return [...candidates];
}

function candidateState(path: string): string {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) return `link:${readlinkSync(path)}`;
		if (stats.isDirectory()) return 'directory';
		if (!stats.isFile()) return 'other';
		return path.endsWith('package.json') ? `file:${digest(readFileSync(path))}` : 'file';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
		return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
	}
}

async function candidateStateAsync(path: string): Promise<string> {
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink()) return `link:${await readlink(path)}`;
		if (stats.isDirectory()) return 'directory';
		if (!stats.isFile()) return 'other';
		return path.endsWith('package.json') ? `file:${digest(await readFile(path))}` : 'file';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
		return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
	}
}

function digest(source: Source): string {
	return createHash('sha256').update(source).digest('base64');
}
