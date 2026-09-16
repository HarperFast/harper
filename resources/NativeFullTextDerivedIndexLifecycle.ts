import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loggerWithTag } from '../utility/logging/logger.ts';
import {
	FullTextDerivedIndexBackend,
	type FullTextDerivedIndexBackendOptions,
	type FullTextDerivedIndexEngine,
	type FullTextDerivedIndexInspection,
} from './FullTextDerivedIndexBackend.ts';
import {
	FULLTEXT_MUTATION_BATCH_HEADER_BYTES,
	FULLTEXT_NATIVE_MAX_CURSOR_PAYLOAD_BYTES,
	FULLTEXT_NATIVE_MAX_FIELDS,
	loadFullTextNativeBinding,
	type NativeFullTextIndexConfiguration,
	type NativeFullTextModule,
	validateFullTextNativeBinding,
} from './fullTextNativeBinding.ts';

const logger = loggerWithTag('fulltext-derived-index');

export type NativeFullTextDerivedIndexLifecycleOptions = NativeFullTextIndexConfiguration & {
	storePath: string;
	storeName: string;
	indexId: string;
	sourceGeneration: string;
	binding?: NativeFullTextModule | (() => Promise<NativeFullTextModule>);
};

export type NativeFullTextDerivedIndexBackendOptions = Omit<FullTextDerivedIndexBackendOptions, 'lifecycle'> &
	Omit<NativeFullTextDerivedIndexLifecycleOptions, 'indexId'>;

export class NativeFullTextDerivedIndexLifecycle {
	readonly #options: NativeFullTextDerivedIndexLifecycleOptions;
	readonly #path: string;
	readonly #generation: string;
	#binding?: NativeFullTextModule;
	#invalidHandle?: { close(options: { mode: 'rollback' }): Promise<void> };

	constructor(options: NativeFullTextDerivedIndexLifecycleOptions) {
		if (!isAbsolute(options.storePath)) throw new TypeError('Full-text storePath must be absolute');
		if (!options.storeName) throw new TypeError('Full-text storeName is required');
		if (!options.indexId) throw new TypeError('Full-text indexId is required');
		if (!options.sourceGeneration) throw new TypeError('Full-text sourceGeneration is required');
		validateNativeConfiguration(options);
		this.#options = {
			...options,
			fields: options.fields.map((field) => ({ ...field })),
			limits: { ...options.limits },
		};
		this.#path = join(resolve(options.storePath), `${digest(options.storeName)}.fulltext`);
		this.#generation = digest(options.sourceGeneration);
	}

	get path(): string {
		return this.#path;
	}

	async initialize(): Promise<void> {
		await this.#getBinding();
		await this.#reclaimRetired();
	}

	inspect(): FullTextDerivedIndexInspection {
		return this.#requireBinding().inspectNativeFullTextIndex(this.#nativeOptions());
	}

	async open(): Promise<FullTextDerivedIndexEngine> {
		await this.quiesce();
		const engine = await this.#requireBinding().openNativeFullTextIndex({
			...this.#nativeOptions(),
			limits: this.#options.limits,
		});
		if (validEngine(engine)) return engine;
		const error = new TypeError('@harperfast/fulltext/native returned an invalid index handle');
		if (engine && typeof (engine as { close?: unknown }).close === 'function') {
			this.#invalidHandle = engine as { close(options: { mode: 'rollback' }): Promise<void> };
			try {
				await this.quiesce();
			} catch (closeError) {
				throw new AggregateError([error, closeError], 'Invalid full-text index handle could not be closed');
			}
		}
		throw error;
	}

	async reset(): Promise<void> {
		await this.quiesce();
		const result = await this.#requireBinding().resetNativeFullTextIndex({
			path: this.#path,
			indexId: this.#options.indexId,
		});
		if (result.state === 'reset') {
			const retiredRoot = join(dirname(this.#path), '.fulltext-retired');
			let removablePath;
			try {
				removablePath = await canonicalRetiredPath(retiredRoot, result.retiredPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
					logWarning(`Could not validate retired full-text path '${result.retiredPath}'`, error);
				await this.#reclaimRetired();
				return;
			}
			if (!removablePath) {
				logWarning(`Refused to remove invalid retired full-text path '${result.retiredPath}'`, undefined);
			} else {
				await removeRetired(removablePath).catch((error) =>
					logWarning(`Could not remove retired full-text index '${result.retiredPath}'`, error)
				);
			}
		}
		await this.#reclaimRetired();
	}

	async quiesce(): Promise<void> {
		const handle = this.#invalidHandle;
		if (!handle) return;
		try {
			await handle.close({ mode: 'rollback' });
		} catch (error) {
			if (!this.isQuiescedCloseError(error)) throw error;
			logWarning('Invalid full-text index handle closed with a native cleanup error', error);
		}
		if (this.#invalidHandle === handle) this.#invalidHandle = undefined;
	}

	isQuiescedCloseError(error: unknown): boolean {
		return errorCode(error) === 'E_CLOSE_FAILED';
	}

	async #reclaimRetired(): Promise<void> {
		const retiredRoot = join(dirname(this.#path), '.fulltext-retired');
		let canonicalRoot;
		let entries;
		try {
			const stats = await lstat(retiredRoot);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				logWarning(`Refused to inspect invalid retired full-text root '${retiredRoot}'`, undefined);
				return;
			}
			canonicalRoot = await realpath(retiredRoot);
			entries = await readdir(canonicalRoot, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			logWarning(`Could not inspect retired full-text indexes in '${retiredRoot}'`, error);
			return;
		}
		await Promise.all(
			entries.map((entry) =>
				removeRetired(join(canonicalRoot, entry.name)).catch((error) =>
					logWarning(`Could not remove retired full-text index '${join(canonicalRoot, entry.name)}'`, error)
				)
			)
		);
	}

	#nativeOptions(): Omit<NativeFullTextIndexConfiguration, 'limits'> & {
		path: string;
		indexId: string;
		generation: string;
	} {
		return {
			path: this.#path,
			indexId: this.#options.indexId,
			generation: this.#generation,
			fields: this.#options.fields,
			analyzer: this.#options.analyzer,
			stopWords: this.#options.stopWords,
			positions: this.#options.positions,
			surfaceTerms: this.#options.surfaceTerms,
		};
	}

	async #getBinding(): Promise<NativeFullTextModule> {
		if (this.#binding) return this.#binding;
		const configured = this.#options.binding;
		this.#binding = configured
			? await validateFullTextNativeBinding(typeof configured === 'function' ? await configured() : configured)
			: await loadFullTextNativeBinding();
		return this.#binding;
	}

	#requireBinding(): NativeFullTextModule {
		if (!this.#binding) throw new Error('Full-text native binding has not been initialized');
		return this.#binding;
	}
}

export async function createNativeFullTextDerivedIndexBackend(
	options: NativeFullTextDerivedIndexBackendOptions
): Promise<FullTextDerivedIndexBackend> {
	const maxQueuedBytes = options.maxQueuedBytes ?? 64 * 1024 * 1024;
	if (options.limits.maxBatchBytes > maxQueuedBytes)
		throw new RangeError('Full-text maxBatchBytes must not exceed the backend maxQueuedBytes');
	if (
		(options.maxCursorPayloadBytes ?? FULLTEXT_NATIVE_MAX_CURSOR_PAYLOAD_BYTES) >
		FULLTEXT_NATIVE_MAX_CURSOR_PAYLOAD_BYTES
	)
		throw new RangeError(`Full-text maxCursorPayloadBytes must not exceed ${FULLTEXT_NATIVE_MAX_CURSOR_PAYLOAD_BYTES}`);
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({ ...options, indexId: options.id });
	await lifecycle.initialize();
	return new FullTextDerivedIndexBackend({
		...options,
		id: options.id,
		lifecycle,
	});
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function strictChild(parent: string, child: string): boolean {
	const suffix = relative(resolve(parent), resolve(child));
	return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function canonicalRetiredPath(retiredRoot: string, candidate: string): Promise<string | undefined> {
	const stats = await lstat(retiredRoot);
	if (!stats.isDirectory() || stats.isSymbolicLink()) return;
	const [canonicalRoot, canonicalParent] = await Promise.all([realpath(retiredRoot), realpath(dirname(candidate))]);
	const canonicalCandidate = join(canonicalParent, basename(candidate));
	if (strictChild(canonicalRoot, canonicalCandidate)) return canonicalCandidate;
}

function removeRetired(path: string): Promise<void> {
	return rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function plainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function errorCode(error: unknown): unknown {
	return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function validEngine(value: unknown): value is FullTextDerivedIndexEngine {
	if (!value || typeof value !== 'object') return false;
	const engine = value as Partial<Record<keyof FullTextDerivedIndexEngine, unknown>>;
	return (
		typeof engine.encodeMutationBatches === 'function' &&
		typeof engine.apply === 'function' &&
		typeof engine.publish === 'function' &&
		typeof engine.close === 'function'
	);
}

function validateNativeConfiguration(options: NativeFullTextDerivedIndexLifecycleOptions): void {
	if (options.analyzer !== 'english@1') throw new TypeError('Full-text analyzer must be english@1');
	if (
		!Array.isArray(options.fields) ||
		options.fields.length === 0 ||
		options.fields.length > FULLTEXT_NATIVE_MAX_FIELDS
	)
		throw new TypeError(`Full-text fields must contain between 1 and ${FULLTEXT_NATIVE_MAX_FIELDS} entries`);
	const names = new Set<string>();
	for (const field of options.fields) {
		if (
			!plainObject(field) ||
			typeof field.name !== 'string' ||
			field.name.length === 0 ||
			field.name === '__fulltext_id' ||
			names.has(field.name)
		)
			throw new TypeError('Full-text field names must be non-empty, unique, and not reserved');
		if (field.weight !== undefined && (!Number.isFinite(field.weight) || field.weight <= 0))
			throw new TypeError('Full-text field weights must be finite and greater than zero');
		names.add(field.name);
	}
	for (const name of ['stopWords', 'positions', 'surfaceTerms'] as const) {
		if (options[name] !== undefined && typeof options[name] !== 'boolean')
			throw new TypeError(`Full-text ${name} must be a boolean`);
	}
	const { limits } = options;
	if (!plainObject(limits)) throw new TypeError('Full-text limits are required');
	for (const name of [
		'indexingThreads',
		'searchThreads',
		'writerMemoryBytes',
		'maxQueuedCommands',
		'maxQueuedBytes',
		'maxBatchBytes',
	] as const) {
		if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0)
			throw new TypeError(`Full-text limits.${name} must be a positive safe integer`);
	}
	if (limits.indexingThreads > 64 || limits.searchThreads > 64)
		throw new RangeError('Full-text thread limits must not exceed 64');
	if (limits.maxQueuedCommands > 0xffff_ffff)
		throw new RangeError('Full-text maxQueuedCommands exceeds its packed integer range');
	const writerMemoryPerThread = limits.writerMemoryBytes / limits.indexingThreads;
	if (writerMemoryPerThread < 15_000_000 || writerMemoryPerThread >= 0xffff_ffff)
		throw new RangeError('Full-text writerMemoryBytes per indexing thread is outside Tantivy limits');
	if (limits.maxBatchBytes > limits.maxQueuedBytes)
		throw new RangeError('Full-text maxBatchBytes must not exceed maxQueuedBytes');
	if (limits.maxBatchBytes <= FULLTEXT_MUTATION_BATCH_HEADER_BYTES)
		throw new RangeError('Full-text maxBatchBytes must exceed the mutation batch header');
}

function logWarning(message: string, error: unknown): void {
	logger.warn?.(message, error);
}
