import type { FullTextDerivedIndexEngine, FullTextMutationBatch } from './FullTextDerivedIndexBackend.ts';

const FULLTEXT_NATIVE_ABI_VERSION = 4;

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

export interface NativeFullTextModule {
	runtimeInfo(): Promise<{
		packageVersion: string;
		tantivyVersion: string;
		nativeAbiVersion: number;
		storageBackends: ReadonlyArray<'native'>;
	}>;
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
	encodeMutationBatch(batch: FullTextMutationBatch, maxBytes?: number): Uint8Array;
}

let bindingPromise: Promise<NativeFullTextModule> | undefined;

export async function loadFullTextNativeBinding(): Promise<NativeFullTextModule> {
	if (!bindingPromise) {
		const moduleName = '@harperfast/fulltext/native';
		bindingPromise = import(moduleName).then(validateFullTextNativeBinding);
		bindingPromise.catch(() => (bindingPromise = undefined));
	}
	return bindingPromise;
}

export async function validateFullTextNativeBinding(module: unknown): Promise<NativeFullTextModule> {
	if (
		!module ||
		typeof module !== 'object' ||
		!('runtimeInfo' in module) ||
		typeof module.runtimeInfo !== 'function' ||
		!('openNativeFullTextIndex' in module) ||
		typeof module.openNativeFullTextIndex !== 'function' ||
		!('inspectNativeFullTextIndex' in module) ||
		typeof module.inspectNativeFullTextIndex !== 'function' ||
		!('resetNativeFullTextIndex' in module) ||
		typeof module.resetNativeFullTextIndex !== 'function' ||
		!('encodeMutationBatch' in module) ||
		typeof module.encodeMutationBatch !== 'function'
	)
		throw new TypeError('@harperfast/fulltext/native does not implement the required Harper binding contract');
	const binding = module as NativeFullTextModule;
	const info = await binding.runtimeInfo();
	if (
		!info ||
		typeof info.packageVersion !== 'string' ||
		typeof info.tantivyVersion !== 'string' ||
		info.nativeAbiVersion !== FULLTEXT_NATIVE_ABI_VERSION ||
		!Array.isArray(info.storageBackends) ||
		!info.storageBackends.includes('native')
	)
		throw new TypeError('@harperfast/fulltext/native reported incompatible runtime capabilities');
	return binding;
}
