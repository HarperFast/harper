import type { FullTextDerivedIndexEngine, FullTextMutationBatch } from './FullTextDerivedIndexBackend.ts';

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
		storageBackends: ReadonlyArray<'native' | 'harper'>;
	}>;
	openNativeFullTextIndex(
		options: NativeFullTextIndexConfiguration & {
			path: string;
			indexId: string;
			generation: string;
		}
	): Promise<FullTextDerivedIndexEngine>;
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
		!Number.isSafeInteger(info.nativeAbiVersion) ||
		!Array.isArray(info.storageBackends) ||
		!info.storageBackends.includes('native')
	)
		throw new TypeError('@harperfast/fulltext/native reported incompatible runtime capabilities');
	return binding;
}
