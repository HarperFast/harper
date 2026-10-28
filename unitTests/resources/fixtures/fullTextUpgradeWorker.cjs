'use strict';

const { parentPort } = require('node:worker_threads');
const { onMessageFromWorkers } = require('#src/server/threads/manageThreads');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { FULL_TEXT_QUERY_PAUSE_OPERATION } = require('#src/resources/indexes/fullTextQueryProtocol');
let Product;
let gate;
let failClose = false;
let releaseLease;
let nativeBinding;
let readerOptions;
const failedReaders = new Set();

onMessageFromWorkers((event) => {
	if (event.message?.operation === FULL_TEXT_QUERY_PAUSE_OPERATION)
		setImmediate(() => parentPort.postMessage({ event: 'pause-delivered' }));
});

parentPort.on('message', async ({ id, command, ...data }) => {
	if (!command) return;
	try {
		let result;
		if (command === 'initialize') {
			for (const [parameter, value] of Object.entries(data.environment)) env.setProperty(parameter, value);
			gate = new Int32Array(data.gate);
			const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
			const { setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
			const binding = (nativeBinding = await loadFullTextNativeBinding());
			setFullTextNativeBindingForTests({
				binding: {
					...binding,
					async openNativeFullTextReader(options) {
						readerOptions = options;
						const reader = await binding.openNativeFullTextReader(options);
						return new Proxy(reader, {
							get(target, property) {
								if (property === 'close')
									return async () => {
										if (failClose) {
											failClose = false;
											failedReaders.add(target);
											parentPort.postMessage({ event: 'close-refused' });
											throw new Error('injected reader close failure');
										}
										if (Atomics.load(gate, 5)) Atomics.compareExchange(gate, 7, 0, Atomics.add(gate, 3, 1) + 1);
										const closed = await target.close();
										Atomics.store(gate, 1, Atomics.add(gate, 3, 1) + 1);
										parentPort.postMessage({ event: 'reader-closed' });
										return closed;
									};
								const value = Reflect.get(target, property, target);
								return typeof value === 'function' ? value.bind(target) : value;
							},
						});
					},
					async resetNativeFullTextIndex(options) {
						if (Atomics.load(gate, 5)) {
							Atomics.add(gate, 4, 1);
							Atomics.compareExchange(gate, 2, 0, Atomics.add(gate, 3, 1) + 1);
						}
						let reset;
						try {
							reset = await binding.resetNativeFullTextIndex(options);
						} catch (error) {
							if (Atomics.load(gate, 5) && error.code === 'E_LOCK_BUSY') Atomics.add(gate, 8, 1);
							throw error;
						}
						if (data.holdReset) {
							parentPort.postMessage({ event: 'reset-completed' });
							await new Promise(() => {});
						}
						return reset;
					},
				},
				...data.lifecycleTimeouts,
			});
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT_REQUEST_BUDGET_MILLISECONDS, 30000);
			const databases = require('#src/resources/databases');
			databases.resetRocksCompression();
			Product = databases.table(data.declaration);
			result = { generation: Product.fullTextIndexGenerations.search };
		} else if (command === 'search') {
			const rows = [];
			let held = false;
			for await (const row of Product.search({
				conditions: [{ attribute: 'search', comparator: 'matches', value: 'shoe', waitForIndexMilliseconds: 5000 }],
				limit: 10,
				...(data.hold
					? {
							rowFilter() {
								if (!held) {
									held = true;
									parentPort.postMessage({ event: 'query-held' });
									if (Atomics.wait(gate, 0, 0, 15000) !== 'ok') throw new Error('reader gate was not released');
								}
								return true;
							},
						}
					: null),
			}))
				rows.push(row.id);
			result = rows;
		} else if (command === 'hold-responsive-lease') {
			const leaseGate = Promise.withResolvers();
			releaseLease = leaseGate.resolve;
			const queryIndex = Product.fullTextQueryIndexes.search.customIndex;
			const hits = await queryIndex.search(
				{ comparator: 'matches', value: 'shoe', maxIndexLagMilliseconds: 30000 },
				undefined,
				{
					minResults: 1,
					filter: () => true,
					candidateKeys: {
						estimatedCount: 1,
						async collect(maxKeys) {
							if (maxKeys < 1) throw new Error('candidate collection was not admitted');
							parentPort.postMessage({ event: 'responsive-lease-held' });
							await leaseGate.promise;
							return { keys: new Set(['shoe-1']), complete: true };
						},
					},
				}
			);
			result = hits.map(({ key }) => key);
		} else if (command === 'release-responsive-lease') {
			Atomics.store(gate, 6, Atomics.add(gate, 3, 1) + 1);
			releaseLease?.();
		} else if (command === 'inspect') result = nativeBinding.inspectNativeFullTextIndex(readerOptions);
		else if (command === 'fail-close') failClose = true;
		else if (command === 'release-close') {
			for (const reader of failedReaders) {
				await reader.close();
				Atomics.store(gate, 1, Atomics.add(gate, 3, 1) + 1);
			}
			failedReaders.clear();
		}
		parentPort.postMessage({ id, result });
	} catch (error) {
		parentPort.postMessage({ id, error: { message: error.message, stack: error.stack, code: error.code } });
	}
});

parentPort.ref();
