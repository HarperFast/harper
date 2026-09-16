import type { FullTextDerivedIndexEngine } from './FullTextDerivedIndexBackend.ts';

const FULLTEXT_LIFECYCLE_API_VERSION = 1;

export interface NativeFullTextIndexConfiguration {
	fields: Array<{ name: string; weight?: number }>;
	analyzer: 'english@1';
	stopWords?: boolean;
	positions?: boolean;
	surfaceTerms?: boolean;
	limits: {
		indexingThreads: number;
		searchThreads: number;
		writerMemoryBytes: number;
		maxQueuedCommands: number;
		maxQueuedBytes: number;
		maxBatchBytes: number;
	};
}

export type NativeFullTextRuntimeInfo = {
	packageVersion: string;
	tantivyVersion: string;
	nativeAbiVersion: number;
	lifecycleApiVersion: number;
	mutationBatchApiVersion: number;
	storageBackends: ReadonlyArray<'native'>;
	limits: { maxCommitPayloadBytes: number };
};

export interface NativeFullTextModule {
	NativeFullTextIndex: {
		prototype: Pick<FullTextDerivedIndexEngine, 'applyMutationBatch' | 'publish' | 'close'>;
	};
	runtimeInfo(): Promise<NativeFullTextRuntimeInfo>;
	validateNativeFullTextIndexOptions(
		options: NativeFullTextIndexConfiguration & {
			path: string;
			indexId: string;
			generation: string;
		}
	): void;
	openNativeFullTextIndex(
		options: NativeFullTextIndexConfiguration & {
			path: string;
			indexId: string;
			generation: string;
		}
	): Promise<FullTextDerivedIndexEngine>;
	inspectNativeFullTextIndex(
		options: Omit<NativeFullTextIndexConfiguration, 'limits'> & {
			path: string;
			indexId: string;
			generation: string;
		}
	):
		| { state: 'missing' | 'cursorless' }
		| { state: 'checkpointed'; committedPayload: string }
		| { state: 'incompatible'; code: string };
	resetNativeFullTextIndex(options: {
		path: string;
		indexId: string;
	}): Promise<{ state: 'missing' } | { state: 'reset'; retiredPath: string }>;
	reclaimRetiredNativeFullTextIndexes(options: {
		path: string;
		retiredPath?: string;
	}): Promise<{ removed: number; failed: number }>;
}

let bindingPromise: Promise<NativeFullTextModule> | undefined;
const validatedRuntimeInfo = new WeakMap<NativeFullTextModule, NativeFullTextRuntimeInfo>();

export async function loadFullTextNativeBinding(): Promise<NativeFullTextModule> {
	if (!bindingPromise) {
		const moduleName = '@harperfast/fulltext/native';
		bindingPromise = import(moduleName).then(validateFullTextNativeBinding);
		bindingPromise.catch(() => (bindingPromise = undefined));
	}
	return bindingPromise;
}

export async function validateFullTextNativeBinding(module: unknown): Promise<NativeFullTextModule> {
	const prototype = (module as { NativeFullTextIndex?: { prototype?: Partial<FullTextDerivedIndexEngine> } })
		?.NativeFullTextIndex?.prototype;
	if (
		!module ||
		typeof module !== 'object' ||
		!('runtimeInfo' in module) ||
		typeof module.runtimeInfo !== 'function' ||
		!('NativeFullTextIndex' in module) ||
		typeof module.NativeFullTextIndex !== 'function' ||
		typeof prototype?.applyMutationBatch !== 'function' ||
		typeof prototype.publish !== 'function' ||
		typeof prototype.close !== 'function' ||
		!('openNativeFullTextIndex' in module) ||
		typeof module.openNativeFullTextIndex !== 'function' ||
		!('validateNativeFullTextIndexOptions' in module) ||
		typeof module.validateNativeFullTextIndexOptions !== 'function' ||
		!('inspectNativeFullTextIndex' in module) ||
		typeof module.inspectNativeFullTextIndex !== 'function' ||
		!('resetNativeFullTextIndex' in module) ||
		typeof module.resetNativeFullTextIndex !== 'function' ||
		!('reclaimRetiredNativeFullTextIndexes' in module) ||
		typeof module.reclaimRetiredNativeFullTextIndexes !== 'function'
	)
		throw new TypeError('@harperfast/fulltext/native does not implement the required Harper binding contract');
	const binding = module as NativeFullTextModule;
	const info = await binding.runtimeInfo();
	if (
		!info ||
		typeof info.packageVersion !== 'string' ||
		typeof info.tantivyVersion !== 'string' ||
		!Number.isSafeInteger(info.nativeAbiVersion) ||
		info.lifecycleApiVersion !== FULLTEXT_LIFECYCLE_API_VERSION ||
		info.mutationBatchApiVersion !== 3 ||
		!Array.isArray(info.storageBackends) ||
		!info.storageBackends.includes('native') ||
		!info.limits ||
		!Number.isSafeInteger(info.limits.maxCommitPayloadBytes) ||
		info.limits.maxCommitPayloadBytes <= 0
	)
		throw new TypeError('@harperfast/fulltext/native reported incompatible runtime capabilities');
	validatedRuntimeInfo.set(binding, info);
	return binding;
}

export function getValidatedFullTextRuntimeInfo(binding: NativeFullTextModule): NativeFullTextRuntimeInfo {
	const info = validatedRuntimeInfo.get(binding);
	if (!info) throw new Error('Full-text native binding has not been validated');
	return info;
}
