import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import {
	FullTextDerivedIndexBackend,
	HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES,
	type FullTextDerivedIndexBackendOptions,
	type FullTextDerivedIndexEngine,
	type FullTextDerivedIndexInspection,
} from './fullTextDerivedIndex.ts';
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

export type RetireNativeFullTextDerivedIndexStorageOptions = Pick<
	NativeFullTextDerivedIndexLifecycleOptions,
	'storePath' | 'storeName' | 'indexId' | 'binding'
>;

export class NativeFullTextDerivedIndexLifecycle {
	readonly #options: NativeFullTextDerivedIndexLifecycleOptions;
	readonly #path: string;
	readonly #generation: string;
	#binding?: NativeFullTextModule;
	#maxCommitPayloadBytes?: number;
	#reclaimOperation = Promise.resolve();

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
		// Hashing bounds filenames for arbitrary store names; the index id remains in native metadata and logs.
		this.#path = nativeFullTextIndexPath(options.storePath, options.storeName);
		this.#generation = digest(options.sourceGeneration);
	}

	get path(): string {
		return this.#path;
	}

	async initialize(options: { reclaimRetired?: boolean } = {}): Promise<void> {
		const binding = await this.#getBinding();
		binding.validateNativeFullTextIndexOptions({
			...this.#nativeOptions(),
			limits: this.#options.limits,
		});
		this.#maxCommitPayloadBytes = getValidatedFullTextRuntimeInfo(binding).limits.maxCommitPayloadBytes;
		if (options.reclaimRetired !== false) this.#queueReclaimRetired();
	}

	startRetiredStorageReclamation(): void {
		this.#requireBinding();
		// Fulltext publishes unique retired paths and removes them with force, so workers may sweep concurrently.
		this.#queueReclaimRetired();
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
		this.#queueReclaimRetired(result.state === 'reset' ? result.retiredPath : undefined);
	}

	#queueReclaimRetired(retiredPath?: string): void {
		const reclaim = () => this.#reclaimRetired(retiredPath);
		this.#reclaimOperation = this.#reclaimOperation.then(reclaim, reclaim).catch((error) => {
			logWarning(`Could not complete reclamation for full-text index '${this.#options.indexId}'`, error);
		});
	}

	async #reclaimRetired(retiredPath?: string): Promise<void> {
		try {
			const result = await this.#requireBinding().reclaimRetiredNativeFullTextIndexes({
				path: this.#path,
				retiredPath,
			});
			if (result.failed > 0)
				logWarning(`Could not remove ${result.failed} retired paths for full-text index '${this.#options.indexId}'`);
		} catch (error) {
			logWarning(`Could not reclaim retired paths for full-text index '${this.#options.indexId}'`, error);
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
		this.#binding = await resolveNativeFullTextBinding(this.#options.binding);
		return this.#binding;
	}

	#requireBinding(): NativeFullTextModule {
		if (!this.#binding) throw new Error('Full-text native binding has not been initialized');
		return this.#binding;
	}
}

/** Retire one quiesced native directory after its Harper declaration or table is removed. */
export async function retireNativeFullTextDerivedIndexStorage(
	options: RetireNativeFullTextDerivedIndexStorageOptions
): Promise<void> {
	if (!isAbsolute(options.storePath)) throw new TypeError('Full-text storePath must be absolute');
	if (!options.storeName) throw new TypeError('Full-text storeName is required');
	if (!options.indexId) throw new TypeError('Full-text indexId is required');
	const path = nativeFullTextIndexPath(options.storePath, options.storeName);
	if (!existsSync(path)) {
		if (existsSync(join(dirname(path), '.fulltext-retired'))) {
			try {
				const binding = await resolveNativeFullTextBinding(options.binding);
				const reclaimed = await binding.reclaimRetiredNativeFullTextIndexes({ path });
				if (reclaimed.failed > 0)
					logWarning(`Could not remove ${reclaimed.failed} retired paths for full-text index '${options.indexId}'`);
			} catch (error) {
				logWarning(`Could not reclaim retired storage for full-text index '${options.indexId}'`, error);
			}
		}
		return;
	}
	const binding = await resolveNativeFullTextBinding(options.binding);
	// The wrapper owns the physical lifecycle fence: reset refuses an active/unproven writer and
	// takes Tantivy's writer lock before renaming. Harper treats that refusal as best-effort cleanup,
	// never as permission to remove a live directory itself.
	const result = await binding.resetNativeFullTextIndex({ path, indexId: options.indexId });
	void binding
		.reclaimRetiredNativeFullTextIndexes({
			path,
			retiredPath: result.state === 'reset' ? result.retiredPath : undefined,
		})
		.then((reclaimed) => {
			if (reclaimed.failed > 0)
				logWarning(`Could not remove ${reclaimed.failed} retired paths for full-text index '${options.indexId}'`);
		})
		.catch((error) => logWarning(`Could not reclaim retired storage for full-text index '${options.indexId}'`, error));
}

export async function createNativeFullTextDerivedIndexBackend(
	options: NativeFullTextDerivedIndexBackendOptions
): Promise<FullTextDerivedIndexBackend> {
	const configuredMaxCursorPayloadBytes = options.maxCursorPayloadBytes;
	if (
		configuredMaxCursorPayloadBytes !== undefined &&
		configuredMaxCursorPayloadBytes > HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES
	)
		throw new RangeError(`Full-text maxCursorPayloadBytes must not exceed ${HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES}`);
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({ ...options, indexId: options.id });
	await lifecycle.initialize({ reclaimRetired: false });
	if (
		configuredMaxCursorPayloadBytes !== undefined &&
		configuredMaxCursorPayloadBytes > lifecycle.maxCommitPayloadBytes
	)
		throw new RangeError('Full-text maxCursorPayloadBytes exceeds the native commit payload capacity');
	const maxCursorPayloadBytes = Math.min(
		configuredMaxCursorPayloadBytes ?? HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES,
		lifecycle.maxCommitPayloadBytes
	);
	const backend = new FullTextDerivedIndexBackend({
		...options,
		id: options.id,
		lifecycle,
		maxCursorPayloadBytes,
	});
	lifecycle.startRetiredStorageReclamation();
	return backend;
}

function nativeFullTextIndexPath(storePath: string, storeName: string): string {
	return join(resolve(storePath), `${digest(storeName)}.fulltext`);
}

async function resolveNativeFullTextBinding(
	configured?: NativeFullTextModule | (() => Promise<NativeFullTextModule>)
): Promise<NativeFullTextModule> {
	return configured
		? validateFullTextNativeBinding(typeof configured === 'function' ? await configured() : configured)
		: loadFullTextNativeBinding();
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function logWarning(message: string, error?: unknown): void {
	const code =
		error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
	try {
		logger.warn?.(`${message}${code ? ` (${code})` : ''}`);
	} catch {}
}
