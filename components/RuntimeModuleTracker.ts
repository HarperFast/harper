import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Source = string | Buffer;

const MODULE_COMPARE_CONCURRENCY = 16;
const RESOLUTION_EXTENSIONS = ['', '.js', '.json', '.node', '.ts', '.tsx', '.cjs', '.mjs'];

type Resolution = {
	resolvedUrl: string;
	higherPriorityCandidates?: Map<string, string>;
};

export class RuntimeModuleTracker {
	#getRoot: () => string | undefined;
	#modules = new Map<string, string>();
	#resolutions = new Map<string, Resolution>();
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
		const referrerPath = this.#localPath(referrer);
		const resolvedPath = this.#localPath(resolvedUrl);
		if (!referrerPath || !resolvedPath) return;
		const key = `${referrerPath}\0${specifier}`;
		if (!this.#resolutions.has(key)) {
			const candidates = higherPriorityResolutionCandidates(specifier, referrerPath, resolvedPath);
			this.#resolutions.set(key, {
				resolvedUrl,
				higherPriorityCandidates: candidates
					? new Map(candidates.map((candidate) => [candidate, candidateState(candidate)]))
					: undefined,
			});
			if (this.#deployInFlight) this.#loadedDuringDeploy = true;
		}
	}

	finishDeploy(): Promise<boolean> {
		if (!this.#deployInFlight) return this.#comparison ?? Promise.resolve(false);
		this.#deployInFlight = false;
		this.#comparison = this.#compare();
		return this.#comparison;
	}

	async #compare(): Promise<boolean> {
		if (this.#nativeRuntime || this.#loadedDuringDeploy) return true;
		const modules = [...this.#modules];
		for (let start = 0; start < modules.length; start += MODULE_COMPARE_CONCURRENCY) {
			const changed = await Promise.all(
				modules.slice(start, start + MODULE_COMPARE_CONCURRENCY).map(async ([modulePath, previousDigest]) => {
					try {
						return digest(await readFile(modulePath)) !== previousDigest;
					} catch {
						return true;
					}
				})
			);
			if (changed.includes(true)) return true;
		}
		for (const [key, resolution] of this.#resolutions) {
			const separator = key.indexOf('\0');
			const referrerPath = key.slice(0, separator);
			const specifier = key.slice(separator + 1);
			if (
				resolution.higherPriorityCandidates &&
				(
					await Promise.all(
						[...resolution.higherPriorityCandidates].map(
							async ([candidate, previousState]) => (await candidateStateAsync(candidate)) !== previousState
						)
					)
				).includes(true)
			)
				return true;
			try {
				// Node does not invalidate this cache when a component tree is replaced in place.
				if (!invalidateResolutionCache(specifier, referrerPath, resolution.resolvedUrl)) return true;
				const resolved = createRequire(pathToFileURL(referrerPath)).resolve(specifier);
				const resolvedUrl = isAbsolute(resolved) ? pathToFileURL(resolved).toString() : resolved;
				if (resolvedUrl !== resolution.resolvedUrl) return true;
			} catch {
				return true;
			}
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

function higherPriorityResolutionCandidates(
	specifier: string,
	referrerPath: string,
	resolvedPath: string
): string[] | undefined {
	if (!specifier.startsWith('.')) return;
	const basePath = resolve(dirname(referrerPath), specifier);
	const candidates = [...new Set(RESOLUTION_EXTENSIONS.map((extension) => basePath + extension))];
	candidates.push(resolve(basePath, 'package.json'));
	for (const extension of RESOLUTION_EXTENSIONS.slice(1)) candidates.push(resolve(basePath, `index${extension}`));
	const resolvedIndex = candidates.indexOf(resolvedPath);
	if (resolvedIndex === -1) return;
	return candidates.slice(0, resolvedIndex);
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

function invalidateResolutionCache(specifier: string, referrerPath: string, previousResolvedUrl: string): boolean {
	const pathCache = (Module as unknown as { _pathCache?: Record<string, string> })._pathCache;
	if (!pathCache) return false;
	const previousPath = previousResolvedUrl.startsWith('file:')
		? fileURLToPath(previousResolvedUrl)
		: previousResolvedUrl;
	const relativeKey = `${specifier}\0${dirname(referrerPath)}`;
	if (pathCache[relativeKey] === previousPath) delete pathCache[relativeKey];
	if (specifier.startsWith('.')) return true;
	for (const cacheKey of Object.keys(pathCache)) {
		if (cacheKey.startsWith(`${specifier}\0`) && pathCache[cacheKey] === previousPath) delete pathCache[cacheKey];
	}
	return true;
}

function digest(source: Source): string {
	return createHash('sha256').update(source).digest('base64');
}
