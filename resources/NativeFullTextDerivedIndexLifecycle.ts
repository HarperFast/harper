import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loggerWithTag } from '../utility/logging/logger.ts';
import {
	FullTextDerivedIndexBackend,
	type FullTextDerivedIndexBackendOptions,
	type FullTextDerivedIndexEngine,
	type FullTextDerivedIndexInspection,
} from './FullTextDerivedIndexBackend.ts';
import {
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

export type NativeFullTextDerivedIndexBackendOptions = Omit<
	FullTextDerivedIndexBackendOptions,
	'lifecycle' | 'encodeMutationBatch'
> &
	Omit<NativeFullTextDerivedIndexLifecycleOptions, 'indexId'>;

/** Thin Harper adapter around the native binding's storage lifecycle. */
export class NativeFullTextDerivedIndexLifecycle {
	readonly #options: NativeFullTextDerivedIndexLifecycleOptions;
	readonly #path: string;
	readonly #generation: string;
	#binding?: NativeFullTextModule;

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
	}

	inspect(): FullTextDerivedIndexInspection {
		return this.#requireBinding().inspectNativeFullTextIndex(this.#nativeOptions());
	}

	async open(): Promise<FullTextDerivedIndexEngine> {
		return this.#requireBinding().openNativeFullTextIndex({
			...this.#nativeOptions(),
			limits: this.#options.limits,
		});
	}

	async reset(): Promise<void> {
		const result = await this.#requireBinding().resetNativeFullTextIndex({
			path: this.#path,
			indexId: this.#options.indexId,
		});
		if (result.state === 'reset') {
			const retiredRoot = join(dirname(this.#path), '.fulltext-retired');
			if (!strictChild(retiredRoot, result.retiredPath)) {
				logWarning(`Refused to remove invalid retired full-text path '${result.retiredPath}'`, undefined);
				return;
			}
			void rm(result.retiredPath, { recursive: true, force: true }).catch((error) =>
				logWarning(`Could not remove retired full-text index '${result.retiredPath}'`, error)
			);
		}
	}

	encodeMutationBatch(batch: Parameters<NativeFullTextModule['encodeMutationBatch']>[0]): Uint8Array {
		return this.#requireBinding().encodeMutationBatch(batch, this.#options.limits.maxBatchBytes);
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
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({ ...options, indexId: options.id });
	await lifecycle.initialize();
	return new FullTextDerivedIndexBackend({
		...options,
		id: options.id,
		lifecycle,
		encodeMutationBatch: (batch) => lifecycle.encodeMutationBatch(batch),
	});
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function strictChild(parent: string, child: string): boolean {
	const suffix = relative(resolve(parent), resolve(child));
	return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function plainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validateNativeConfiguration(options: NativeFullTextDerivedIndexLifecycleOptions): void {
	if (options.analyzer !== 'english@1') throw new TypeError('Full-text analyzer must be english@1');
	if (!Array.isArray(options.fields) || options.fields.length === 0 || options.fields.length > 0xffff)
		throw new TypeError('Full-text fields must contain between 1 and 65535 entries');
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
}

function logWarning(message: string, error: unknown): void {
	logger.warn?.(message, error);
}
