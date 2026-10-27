'use strict';

require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { startWorker, setMainIsWorker, getWorkerIndex } = require('#src/server/threads/manageThreads');
const { table, closeDatabase, getRocksCompression } = require('#src/resources/databases');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { nativeFullTextIndexPath } = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');
const {
	fullTextDerivedIndexReadiness,
	setFullTextNativeBindingForTests,
	suspendDerivedIndexActivation,
} = require('#src/resources/derivedIndexes');
const { fullTextRetirementInProgress } = require('#src/resources/derivedIndexRegistry');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');

const FIXTURE = path.join(__dirname, 'fixtures/fullTextUpgradeWorker.cjs');

function declaration(database, indexed = true) {
	return {
		database,
		table: 'Product',
		audit: true,
		attributes: [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		],
		fullTextIndexes: indexed
			? [
					{
						name: 'search',
						fields: [{ name: 'title', weight: 1 }],
						analyzer: 'english@2',
						stopWords: true,
						positions: true,
						surfaceTerms: true,
						synonyms: [],
					},
				]
			: [],
	};
}

async function records(Product) {
	const rows = [];
	for await (const row of Product.search({
		conditions: [
			{
				attribute: 'search',
				comparator: 'matches',
				value: 'shoe',
				maxIndexLagMilliseconds: 0,
				waitForIndexMilliseconds: 5000,
			},
		],
		limit: 10,
	}))
		rows.push({ id: row.id, title: row.title });
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function managedWorker(index) {
	const events = [];
	const pending = new Map();
	let nextId = 0;
	const worker = startWorker(FIXTURE, { name: 'http', workerIndex: index, threadCount: 2, autoRestart: false });
	worker.on('message', (message) => {
		if (message.event) events.push(message.event);
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error));
		else request.resolve(message.result);
	});
	worker.on('error', (error) => {
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	});
	worker.on('exit', (code) => {
		for (const request of pending.values()) request.reject(new Error(`worker exited: ${code}`));
		pending.clear();
	});
	return {
		worker,
		events,
		request(command, data = {}) {
			return new Promise((resolve, reject) => {
				const id = ++nextId;
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`worker ${command} did not settle within 20000ms`));
				}, 20000);
				pending.set(id, {
					resolve(value) {
						clearTimeout(timeout);
						resolve(value);
					},
					reject(error) {
						clearTimeout(timeout);
						reject(error);
					},
				});
				try {
					worker.postMessage({ id, command, ...data });
				} catch (error) {
					pending.get(id).reject(error);
					pending.delete(id);
				}
			});
		},
	};
}

function environment() {
	return Object.fromEntries(
		[
			CONFIG_PARAMS.ROOTPATH,
			CONFIG_PARAMS.STORAGE_PATH,
			CONFIG_PARAMS.DATABASES,
			CONFIG_PARAMS.STORAGE_COMPRESSION,
			CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION,
		].map((parameter) => [
			parameter,
			parameter === CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION ? getRocksCompression() : env.get(parameter),
		])
	);
}

describe('published native full-text managed-worker rebuild safety', function () {
	this.timeout(60000);
	let binding;
	let Product;
	let database;
	let workers;
	let gate;
	let resets;
	let busyResets;
	let trackResets;
	let releaseActivation;
	let mainWasWorker;

	before(async function () {
		mainWasWorker = getWorkerIndex() === 0;
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		binding = await loadFullTextNativeBinding();
	});

	after(() => setMainIsWorker(mainWasWorker));

	beforeEach(() => {
		database = `fulltext-worker-upgrade-${Date.now()}`;
		workers = [];
		gate = new Int32Array(new SharedArrayBuffer(16));
		resets = 0;
		busyResets = 0;
		trackResets = false;
		setFullTextNativeBindingForTests({
			binding: {
				...binding,
				async resetNativeFullTextIndex(options) {
					if (trackResets) {
						resets++;
						Atomics.compareExchange(gate, 2, 0, Atomics.add(gate, 3, 1) + 1);
					}
					try {
						return await binding.resetNativeFullTextIndex(options);
					} catch (error) {
						if (trackResets && error.code === 'E_LOCK_BUSY') busyResets++;
						throw error;
					}
				},
			},
			closeTimeoutMilliseconds: 1000,
			shutdownTimeoutMilliseconds: 2500,
			readerCoordinationTimeoutMilliseconds: 250,
		});
	});

	afterEach(async () => {
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		releaseActivation?.();
		releaseActivation = undefined;
		for (const peer of workers) {
			peer.worker.wasShutdown = true;
			await peer.worker.terminate();
		}
		await closeDatabase(database);
		Product = undefined;
		setFullTextNativeBindingForTests(undefined);
	});

	async function peerReader() {
		const peer = managedWorker(1);
		workers.push(peer);
		const initialized = await peer.request('initialize', {
			environment: environment(),
			gate: gate.buffer,
			declaration: declaration(database),
		});
		assert.strictEqual(initialized.generation, Product.fullTextIndexGenerations.search);
		assert.deepStrictEqual(await peer.request('search'), ['shoe-1']);
		return peer;
	}

	async function readyProduct() {
		Product = table(declaration(database));
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30000);
		await records(Product);
	}

	it('never calls reset while a real peer query misses the drain acknowledgement, then retires after release', async () => {
		await readyProduct();
		const peer = await peerReader();
		const searching = peer.request('search', { hold: true });
		searching.catch(() => {});
		await waitFor(() => peer.events.includes('query-held'), 10000);
		const nativePath = nativeFullTextIndexPath(Product.primaryStore.rootStore.path, 'Product/search');
		trackResets = true;
		Product = table(declaration(database, false));
		await waitFor(() => fullTextRetirementInProgress(Product.primaryStore.rootStore, 'Product'), 5000);
		assert(Product.dbisDB.getSync('Product/')?.fullTextIndexRetirements?.length > 0);
		await waitFor(() => !fullTextRetirementInProgress(Product.primaryStore.rootStore, 'Product'), 5000);
		assert.strictEqual(resets, 0, 'a failed peer acknowledgement must prevent native reset invocation');
		assert(fs.existsSync(nativePath));
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		await searching;
		Product = table(declaration(database, false));
		await waitFor(() => !Product.dbisDB.getSync('Product/')?.fullTextIndexRetirements, 10000);
		assert(peer.events.includes('pause-delivered'), 'production schema ITC must reach the reader worker');
		assert(Atomics.load(gate, 1) > 0, 'the native peer reader must close');
		assert(Atomics.load(gate, 2) > Atomics.load(gate, 1), 'reader lease drain and close must precede native reset');
		assert(resets > 0);
		assert.strictEqual(fs.existsSync(nativePath), false);
	});

	it('lets the native lifecycle fence contain a peer close failure and completes a later retirement retry', async () => {
		await readyProduct();
		const peer = await peerReader();
		const nativePath = nativeFullTextIndexPath(Product.primaryStore.rootStore.path, 'Product/search');
		await peer.request('fail-close');
		trackResets = true;
		Product = table(declaration(database, false));
		await waitFor(() => busyResets > 0, 5000);
		await waitFor(() => !fullTextRetirementInProgress(Product.primaryStore.rootStore, 'Product'), 5000);
		assert(Product.dbisDB.getSync('Product/')?.fullTextIndexRetirements?.length > 0);
		assert(fs.existsSync(nativePath));
		assert.strictEqual((await peer.request('inspect')).state, 'checkpointed');
		await peer.request('release-close');
		Product = table(declaration(database, false));
		await waitFor(() => !Product.dbisDB.getSync('Product/')?.fullTextIndexRetirements, 10000);
		assert(peer.events.includes('close-refused'));
		assert(peer.events.includes('pause-delivered'));
		assert(busyResets > 0, 'a real unclosed native reader must refuse destructive reset');
		assert(resets > busyResets, 'retirement must retry after the actual reader closes');
		assert(Atomics.load(gate, 1) > 0);
	});

	it('rebuilds with a successor after its real owner worker terminates after native reset', async () => {
		Product = table(declaration(database, false));
		await Product.put('shoe-1', { title: 'Trail shoe' });
		releaseActivation = suspendDerivedIndexActivation(Product.primaryStore.rootStore);
		const owner = managedWorker(0);
		workers.push(owner);
		const initialized = await owner.request('initialize', {
			environment: environment(),
			gate: gate.buffer,
			declaration: declaration(database),
			holdReset: true,
		});
		await waitFor(() => owner.events.includes('reset-completed'), 15000);
		releaseActivation();
		releaseActivation = undefined;
		Product = table(declaration(database));
		assert.strictEqual(Product.fullTextIndexGenerations.search, initialized.generation);
		const interruptedEpoch = fullTextDerivedIndexReadiness(Product, 'search').ownerEpoch;
		await assert.rejects(records(Product), (error) => error.statusCode === 503);
		owner.worker.wasShutdown = true;
		await owner.worker.terminate();
		workers.splice(workers.indexOf(owner), 1);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30000);
		assert(fullTextDerivedIndexReadiness(Product, 'search').ownerEpoch > interruptedEpoch);
		assert.strictEqual(Product.fullTextIndexGenerations.search, initialized.generation);
		assert.deepStrictEqual(await records(Product), [{ id: 'shoe-1', title: 'Trail shoe' }]);
	});
});
