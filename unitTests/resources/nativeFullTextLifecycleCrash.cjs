const { NativeFullTextDerivedIndexLifecycle } = require('#src/resources/NativeFullTextDerivedIndexLifecycle');

const [, , storePath, crashPoint] = process.argv;
const limits = {
	indexingThreads: 1,
	searchThreads: 1,
	writerMemoryBytes: 32 * 1024 * 1024,
	maxQueuedCommands: 16,
	maxQueuedBytes: 64 * 1024 * 1024,
	maxBatchBytes: 8 * 1024 * 1024,
};

const binding = {
	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 2,
			storageBackends: ['native'],
		};
	},
	encodeMutationBatch() {
		return Buffer.alloc(0);
	},
	async openNativeFullTextIndex() {
		if (crashPoint === 'before-selector') {
			process.stdout.write('generation-open\n');
			return new Promise(() => {});
		}
		return {
			committedPayload: undefined,
			async apply() {
				return 0;
			},
			async publish() {
				return 0n;
			},
			async close() {},
		};
	},
};

const lifecycle = new NativeFullTextDerivedIndexLifecycle({
	storePath,
	storeName: 'crash-test-index',
	indexId: 'crash-test-index',
	sourceGeneration: 'source-generation-1',
	fields: [{ name: 'title' }],
	analyzer: 'english@1',
	limits,
	binding,
});

lifecycle.replace(1n).then(
	() => {
		process.stdout.write('selector-published\n');
		setInterval(() => {}, 60_000);
	},
	(error) => {
		console.error(error);
		process.exitCode = 1;
	}
);
