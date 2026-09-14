import { createHash, randomUUID } from 'node:crypto';
import {
	closeSync,
	constants,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { renameWithRetry } from '../utility/renameWithRetry.ts';
import {
	FullTextDerivedIndexBackend,
	FullTextDerivedIndexError,
	FullTextGenerationInvalidError,
	type FullTextDerivedIndexBackendOptions,
	type FullTextDerivedIndexEngine,
} from './FullTextDerivedIndexBackend.ts';
import {
	loadFullTextNativeBinding,
	type NativeFullTextIndexConfiguration,
	type NativeFullTextModule,
	validateFullTextNativeBinding,
} from './fullTextNativeBinding.ts';

const SELECTOR_NAME = 'CURRENT';
const METADATA_NAME = 'STORE.json';
const GENERATIONS_NAME = 'generations';
const MAX_CONTROL_FILE_BYTES = 16 * 1024;
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID_NATIVE_CODES = new Set(['E_IDENTITY_MISMATCH', 'E_INCOMPLETE_CREATE', 'E_SCHEMA_MISMATCH']);

type GenerationSelector = {
	format: 1;
	sourceIdentity: string;
	generationId: string;
};

class ControlFilePublicationError extends Error {
	readonly published: boolean;

	constructor(message: string, published: boolean, cause: unknown) {
		super(message, { cause });
		this.published = published;
	}
}

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

export class NativeFullTextDerivedIndexLifecycle {
	readonly #options: NativeFullTextDerivedIndexLifecycleOptions;
	readonly #rootPath: string;
	readonly #generationsPath: string;
	readonly #selectorPath: string;
	readonly #sourceIdentity: string;
	#binding?: NativeFullTextModule;
	#stranded?: { engine: FullTextDerivedIndexEngine; generationId: string; remove: boolean };

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
		this.#sourceIdentity = digest(options.sourceGeneration);
		this.#rootPath = join(resolve(options.storePath), `${digest(options.storeName)}.fulltext`);
		this.#generationsPath = join(this.#rootPath, GENERATIONS_NAME);
		this.#selectorPath = join(this.#rootPath, SELECTOR_NAME);
	}

	get path(): string {
		return this.#rootPath;
	}

	async open(_ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine> {
		await this.#closeStranded();
		this.#ensureLayout();
		const selector = this.#readSelector();
		if (!selector) throw new FullTextGenerationInvalidError('Full-text generation selector is missing');
		if (selector.sourceIdentity !== this.#sourceIdentity)
			throw new FullTextGenerationInvalidError('Full-text source generation does not match the selected index');
		const generationPath = this.#generationPath(selector.generationId);
		this.#assertDirectory(generationPath, 'selected full-text generation');
		const engine = await this.#openGeneration(selector.generationId, generationPath);
		return this.#finishOpen(engine, selector.generationId);
	}

	async replace(_ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine> {
		await this.#closeStranded();
		this.#ensureLayout(true);
		const replacement = await this.#createAndSelect();
		return this.#finishOpen(replacement.engine, replacement.generationId);
	}

	async #finishOpen(engine: FullTextDerivedIndexEngine, generationId: string): Promise<FullTextDerivedIndexEngine> {
		try {
			this.#sweepExcept(generationId);
			return engine;
		} catch (error) {
			try {
				await engine.close({ mode: 'rollback' });
			} catch (closeError) {
				this.#stranded = { engine, generationId, remove: false };
				throw new FullTextDerivedIndexError(
					'Full-text generation could not close after activation failed',
					new AggregateError([error, closeError])
				);
			}
			throw error;
		}
	}

	encodeMutationBatch(batch: Parameters<NativeFullTextModule['encodeMutationBatch']>[0]): Uint8Array {
		if (!this.#binding) throw new Error('Full-text native binding is not open');
		return this.#binding.encodeMutationBatch(batch, this.#options.limits.maxBatchBytes);
	}

	async #createAndSelect(): Promise<{ engine: FullTextDerivedIndexEngine; generationId: string }> {
		const generationId = randomUUID();
		const generationPath = this.#generationPath(generationId);
		mkdirSync(generationPath, { mode: 0o700 });
		this.#assertDirectory(generationPath, 'new full-text generation');
		let engine: FullTextDerivedIndexEngine | undefined;
		try {
			engine = await this.#openGeneration(generationId, generationPath);
			if (engine.committedPayload !== undefined)
				throw new FullTextGenerationInvalidError('A new full-text generation retained a committed cursor');
			this.#syncDirectory(generationPath);
			this.#syncDirectory(this.#generationsPath);
			this.#writeSelector({ format: 1, sourceIdentity: this.#sourceIdentity, generationId });
			return { engine, generationId };
		} catch (error) {
			if (engine) {
				try {
					await engine.close({ mode: 'rollback' });
				} catch (closeError) {
					this.#stranded = {
						engine,
						generationId,
						remove: !(error instanceof ControlFilePublicationError) || !error.published,
					};
					throw new FullTextDerivedIndexError(
						'New full-text generation could not close after activation failed',
						new AggregateError([error, closeError])
					);
				}
			}
			if (!(error instanceof ControlFilePublicationError) || !error.published) this.#removeGeneration(generationId);
			throw error;
		}
	}

	async #closeStranded(): Promise<void> {
		const stranded = this.#stranded;
		if (!stranded) return;
		try {
			await stranded.engine.close({ mode: 'rollback' });
		} catch (error) {
			throw new FullTextDerivedIndexError('A failed full-text generation still owns native resources', error);
		}
		this.#stranded = undefined;
		if (stranded.remove) this.#removeGeneration(stranded.generationId);
	}

	async #openGeneration(generationId: string, generationPath: string): Promise<FullTextDerivedIndexEngine> {
		try {
			const binding = await this.#getBinding();
			return await binding.openNativeFullTextIndex({
				path: generationPath,
				indexId: this.#options.indexId,
				generation: `${this.#sourceIdentity}.${generationId}`,
				fields: this.#options.fields,
				analyzer: this.#options.analyzer,
				stopWords: this.#options.stopWords,
				positions: this.#options.positions,
				surfaceTerms: this.#options.surfaceTerms,
				limits: this.#options.limits,
			});
		} catch (error) {
			if (nativeErrorCode(error) && INVALID_NATIVE_CODES.has(nativeErrorCode(error)!))
				throw new FullTextGenerationInvalidError('The selected full-text generation is incompatible', error);
			throw error;
		}
	}

	async #getBinding(): Promise<NativeFullTextModule> {
		if (this.#binding) return this.#binding;
		const configured = this.#options.binding;
		if (!configured) this.#binding = await loadFullTextNativeBinding();
		else
			this.#binding = await validateFullTextNativeBinding(
				typeof configured === 'function' ? await configured() : configured
			);
		return this.#binding;
	}

	#ensureLayout(repairMetadata = false): void {
		mkdirSync(this.#rootPath, { recursive: true, mode: 0o700 });
		this.#assertDirectory(this.#rootPath, 'full-text index root');
		mkdirSync(this.#generationsPath, { recursive: true, mode: 0o700 });
		this.#assertDirectory(this.#generationsPath, 'full-text generations root');
		const metadataPath = join(this.#rootPath, METADATA_NAME);
		if (!exists(metadataPath)) {
			this.#writeControlFile(metadataPath, JSON.stringify({ format: 1, storeName: this.#options.storeName }));
			return;
		}
		const stat = lstatSync(metadataPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_FILE_BYTES)
			throw new FullTextGenerationInvalidError('Full-text store metadata is invalid');
		let metadata: unknown;
		try {
			metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
		} catch (error) {
			if (repairMetadata) {
				this.#writeControlFile(metadataPath, JSON.stringify({ format: 1, storeName: this.#options.storeName }));
				return;
			}
			throw new FullTextGenerationInvalidError('Full-text store metadata is invalid', error);
		}
		if (plainObject(metadata) && metadata.format === 1) {
			if (typeof metadata.storeName === 'string' && metadata.storeName !== this.#options.storeName)
				throw new FullTextGenerationInvalidError('Full-text store metadata does not match the requested index');
			if (
				metadata.storeName === this.#options.storeName &&
				Object.keys(metadata).every((name) => name === 'format' || name === 'storeName')
			)
				return;
			if (repairMetadata) {
				this.#writeControlFile(metadataPath, JSON.stringify({ format: 1, storeName: this.#options.storeName }));
				return;
			}
		}
		if (repairMetadata && (!plainObject(metadata) || !('format' in metadata))) {
			this.#writeControlFile(metadataPath, JSON.stringify({ format: 1, storeName: this.#options.storeName }));
			return;
		}
		if (
			!plainObject(metadata) ||
			metadata.format !== 1 ||
			metadata.storeName !== this.#options.storeName ||
			Object.keys(metadata).some((name) => name !== 'format' && name !== 'storeName')
		)
			throw new FullTextGenerationInvalidError('Full-text store metadata does not match the requested index');
	}

	#readSelector(): GenerationSelector | undefined {
		if (!exists(this.#selectorPath)) return;
		const stat = lstatSync(this.#selectorPath);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new FullTextGenerationInvalidError('Full-text generation selector is not a regular file');
		if (stat.size > MAX_CONTROL_FILE_BYTES)
			throw new FullTextGenerationInvalidError('Full-text generation selector is too large');
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(this.#selectorPath, 'utf8'));
		} catch (error) {
			throw new FullTextGenerationInvalidError('Full-text generation selector is invalid', error);
		}
		if (
			!plainObject(value) ||
			value.format !== 1 ||
			typeof value.sourceIdentity !== 'string' ||
			typeof value.generationId !== 'string' ||
			!GENERATION_ID_PATTERN.test(value.generationId) ||
			Object.keys(value).some((name) => !['format', 'sourceIdentity', 'generationId'].includes(name))
		)
			throw new FullTextGenerationInvalidError('Full-text generation selector has an unsupported format');
		return value as GenerationSelector;
	}

	#writeSelector(selector: GenerationSelector): void {
		this.#writeControlFile(this.#selectorPath, JSON.stringify(selector));
	}

	#writeControlFile(filePath: string, content: string): void {
		const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		const descriptor = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			writeFileSync(descriptor, content, 'utf8');
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		let published = false;
		try {
			renameWithRetry(tempPath, filePath, { maxRetries: 2, initialDelayMs: 5, maxDelayMs: 10 });
			// A later fsync failure must not reclaim a generation the selector may already name.
			published = true;
			this.#syncDirectory(this.#rootPath);
		} catch (error) {
			void rm(tempPath, { force: true }).catch(() => undefined);
			throw new ControlFilePublicationError('Full-text control file publication failed', published, error);
		}
	}

	#generationPath(generationId: string): string {
		if (!GENERATION_ID_PATTERN.test(generationId))
			throw new FullTextGenerationInvalidError('Full-text generation id is invalid');
		const generationPath = resolve(this.#generationsPath, generationId);
		if (!strictChild(this.#generationsPath, generationPath))
			throw new FullTextGenerationInvalidError('Full-text generation path escaped its root');
		return generationPath;
	}

	#assertDirectory(path: string, label: string): void {
		let stat;
		try {
			stat = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				throw new FullTextGenerationInvalidError(`${label} is missing`, error);
			throw error;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FullTextGenerationInvalidError(`${label} is invalid`);
	}

	#syncDirectory(path: string): void {
		try {
			const descriptor = openSync(path, 'r');
			try {
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
		} catch (error) {
			// Windows cannot open directories as files; its metadata journal supplies the ordering.
			if (process.platform !== 'win32') throw error;
		}
	}

	#sweepExcept(selectedGenerationId: string): void {
		const entries = readdirSync(this.#generationsPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === selectedGenerationId || !GENERATION_ID_PATTERN.test(entry.name)) continue;
			this.#removeGeneration(entry.name);
		}
	}

	#removeGeneration(generationId: string): void {
		let generationPath: string;
		try {
			generationPath = this.#generationPath(generationId);
		} catch (error) {
			logWarning('Refused to remove an invalid full-text generation path', error);
			return;
		}
		if (!strictChild(this.#generationsPath, generationPath)) return;
		void rm(generationPath, { recursive: true, force: true }).catch((error) =>
			logWarning(`Could not remove retired full-text generation '${generationPath}'`, error)
		);
	}
}

export function createNativeFullTextDerivedIndexBackend(
	options: NativeFullTextDerivedIndexBackendOptions
): FullTextDerivedIndexBackend {
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({ ...options, indexId: options.id });
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

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function strictChild(parent: string, child: string): boolean {
	const suffix = relative(resolve(parent), resolve(child));
	return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function nativeErrorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
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
	void import('../utility/logging/logger.ts')
		.then(({ loggerWithTag }) => loggerWithTag('fulltext-derived-index').warn?.(message, error))
		.catch(() => undefined);
}
