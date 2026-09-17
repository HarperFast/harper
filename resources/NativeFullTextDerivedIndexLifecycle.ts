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
	getValidatedFullTextRuntimeInfo,
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
		this.#maxCommitPayloadBytes = getValidatedFullTextRuntimeInfo(binding).limits.maxCommitPayloadBytes;
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
		await this.#reclaimRetired(result.state === 'reset' ? result.retiredPath : undefined);
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

function logWarning(message: string, error: unknown): void {
	logger.warn?.(message, error);
}
