import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { loggerWithTag } from '../utility/logging/logger.ts';
import {
	FullTextDerivedIndexBackend,
	HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES,
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

export type NativeFullTextDerivedIndexBackendOptions = Omit<FullTextDerivedIndexBackendOptions, 'lifecycle'> &
	Omit<NativeFullTextDerivedIndexLifecycleOptions, 'indexId'>;

export class NativeFullTextDerivedIndexLifecycle {
	readonly #options: NativeFullTextDerivedIndexLifecycleOptions;
	readonly #path: string;
	readonly #generation: string;
	#binding?: NativeFullTextModule;
	#invalidHandle?: { close(options: { mode: 'rollback' }): Promise<{ cleanupError?: unknown }> };
	#maxCommitPayloadBytes?: number;

	constructor(options: NativeFullTextDerivedIndexLifecycleOptions) {
		if (!isAbsolute(options.storePath)) throw new TypeError('Full-text storePath must be absolute');
		if (!options.storeName) throw new TypeError('Full-text storeName is required');
		if (!options.indexId) throw new TypeError('Full-text indexId is required');
		if (!options.sourceGeneration) throw new TypeError('Full-text sourceGeneration is required');
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
		const binding = await this.#getBinding();
		binding.validateNativeFullTextIndexOptions({
			...this.#nativeOptions(),
			limits: this.#options.limits,
		});
		this.#maxCommitPayloadBytes = (await binding.runtimeInfo()).limits.maxCommitPayloadBytes;
		await this.#reclaimRetired();
	}

	get maxCommitPayloadBytes(): number {
		if (this.#maxCommitPayloadBytes === undefined) throw new Error('Full-text lifecycle has not been initialized');
		return this.#maxCommitPayloadBytes;
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
			this.#invalidHandle = engine as {
				close(options: { mode: 'rollback' }): Promise<{ cleanupError?: unknown }>;
			};
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
		await this.#reclaimRetired(result.state === 'reset' ? result.retiredPath : undefined);
	}

	async quiesce(): Promise<void> {
		const handle = this.#invalidHandle;
		if (!handle) return;
		const result = await handle.close({ mode: 'rollback' });
		if (result.cleanupError)
			logWarning('Invalid full-text index handle closed with a native cleanup error', result.cleanupError);
		if (this.#invalidHandle === handle) this.#invalidHandle = undefined;
	}

	async #reclaimRetired(retiredPath?: string): Promise<void> {
		try {
			const result = await this.#requireBinding().reclaimRetiredNativeFullTextIndexes({
				path: this.#path,
				retiredPath,
			});
			if (result.failed > 0)
				logWarning(`Could not remove ${result.failed} retired full-text index paths for '${this.#path}'`, undefined);
		} catch (error) {
			logWarning(`Could not reclaim retired full-text indexes for '${this.#path}'`, error);
		}
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
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({ ...options, indexId: options.id });
	await lifecycle.initialize();
	const maxCursorPayloadBytes = options.maxCursorPayloadBytes ?? HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES;
	if (maxCursorPayloadBytes > HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES)
		throw new RangeError(`Full-text maxCursorPayloadBytes must not exceed ${HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES}`);
	if (maxCursorPayloadBytes > lifecycle.maxCommitPayloadBytes)
		throw new RangeError('Full-text maxCursorPayloadBytes exceeds the native commit payload capacity');
	return new FullTextDerivedIndexBackend({
		...options,
		id: options.id,
		lifecycle,
		maxCursorPayloadBytes,
	});
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
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

function logWarning(message: string, error: unknown): void {
	logger.warn?.(message, error);
}
