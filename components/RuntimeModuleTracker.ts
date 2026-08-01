import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Source = string | Buffer;

const MODULE_COMPARE_CONCURRENCY = 16;

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
		const referrerPath = this.#localPath(referrer);
		if (!referrerPath || !this.#localPath(resolvedUrl)) return;
		const key = `${referrerPath}\0${specifier}`;
		if (!this.#resolutions.has(key)) this.#resolutions.set(key, resolvedUrl);
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
		for (const [key, previousResolvedUrl] of this.#resolutions) {
			const separator = key.indexOf('\0');
			const referrerPath = key.slice(0, separator);
			const specifier = key.slice(separator + 1);
			try {
				// Node does not invalidate this cache when a component tree is replaced in place.
				invalidateResolutionCache(specifier, referrerPath, previousResolvedUrl);
				const resolved = createRequire(pathToFileURL(referrerPath)).resolve(specifier);
				const resolvedUrl = isAbsolute(resolved) ? pathToFileURL(resolved).toString() : resolved;
				if (resolvedUrl !== previousResolvedUrl) return true;
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

function invalidateResolutionCache(specifier: string, referrerPath: string, previousResolvedUrl: string): void {
	const pathCache = (Module as unknown as { _pathCache?: Record<string, string> })._pathCache;
	if (!pathCache) return;
	const previousPath = previousResolvedUrl.startsWith('file:')
		? fileURLToPath(previousResolvedUrl)
		: previousResolvedUrl;
	const relativeKey = `${specifier}\0${dirname(referrerPath)}`;
	if (pathCache[relativeKey] === previousPath) delete pathCache[relativeKey];
	if (specifier.startsWith('.')) return;
	for (const cacheKey of Object.keys(pathCache)) {
		if (cacheKey.startsWith(`${specifier}\0`) && pathCache[cacheKey] === previousPath) delete pathCache[cacheKey];
	}
}

function digest(source: Source): string {
	return createHash('sha256').update(source).digest('base64');
}
