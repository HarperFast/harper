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
		bindingPromise = import(moduleName) as Promise<NativeFullTextModule>;
		bindingPromise.catch(() => (bindingPromise = undefined));
	}
	return bindingPromise;
}
