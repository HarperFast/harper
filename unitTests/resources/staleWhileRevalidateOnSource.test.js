'use strict';

require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table, getDatabases } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');

// harper#1468: allowStaleWhileRevalidate defined on the source passed to sourcedFrom
describe('Stale-while-revalidate hook on the source', function () {
	this.timeout(10_000);
	let ClassSourced;
	let ObjectSourced;
	let StaticSourced;
	let QuerySourced;
	let Warned;
	let Evicting;
	let TableDecides;
	let SubclassAllows;
	let sourceCalls;
	let pendingCalls;
	let hookCalls;
	let allowStale;
	let touched;
	let warnings;
	let originalWarn;
	const heldGet = () => {
		sourceCalls++;
		return new Promise((resolve, reject) => pendingCalls.push({ resolve, reject }));
	};
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		const attributes = [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'name', indexed: true },
		];
		ClassSourced = table({ table: 'SwrOnSourceClass', database: 'test', attributes });
		ObjectSourced = table({ table: 'SwrOnSourceObject', database: 'test', attributes });
		StaticSourced = table({ table: 'SwrOnSourceStatic', database: 'test', attributes });
		QuerySourced = table({ table: 'SwrOnSourceQuery', database: 'test', attributes });
		Warned = table({ table: 'SwrOnSourceWarned', database: 'test', attributes });
		Evicting = table({ table: 'SwrOnSourceEvicting', database: 'test', attributes });
		const Hookless = table({ table: 'SwrOnSourceHookless', database: 'test', attributes });
		getDatabases();
		class StalePolicy extends Resource {
			allowStaleWhileRevalidate(entry, id) {
				hookCalls.push({ id, instanceId: this.getId(), name: entry.value?.name });
				return allowStale;
			}
		}
		class Origin extends StalePolicy {
			get() {
				return heldGet();
			}
		}
		ClassSourced.sourcedFrom(Origin);
		QuerySourced.sourcedFrom(Origin);
		Warned.sourcedFrom(Origin);
		Evicting.sourcedFrom(Origin, { eviction: 60 });
		Hookless.sourcedFrom({ get: heldGet });
		SubclassAllows = class extends Hookless {
			allowStaleWhileRevalidate() {
				return true;
			}
		};
		ObjectSourced.sourcedFrom({
			get: heldGet,
			allowStaleWhileRevalidate(entry, id) {
				hookCalls.push({ id, name: entry.value?.name });
				return allowStale;
			},
		});
		StaticSourced.sourcedFrom(
			class StaticOrigin extends Resource {
				static get() {
					return heldGet();
				}
				static allowStaleWhileRevalidate(entry, id) {
					hookCalls.push({ id, name: entry.value?.name });
					return allowStale;
				}
			}
		);
		TableDecides = class extends ClassSourced {
			allowStaleWhileRevalidate() {
				return false;
			}
		};
	});
	beforeEach(function () {
		sourceCalls = 0;
		pendingCalls = [];
		hookCalls = [];
		allowStale = true;
		touched = [];
		warnings = [];
		originalWarn = logger.warn;
		logger.warn = (...args) => warnings.push(args.map((arg) => arg?.message ?? String(arg)).join(' '));
	});
	afterEach(async function () {
		logger.warn = originalWarn;
		for (const call of pendingCalls) call.resolve(undefined);
		await waitFor(() => touched.every(([Table, id]) => !Table.primaryStore.hasLock(id)), {
			message: 'a background refresh did not finish',
		});
	});
	const expire = (Table, id) => {
		touched.push([Table, id]);
		// as the source wrote it, so a Resource source's put is not called
		return Table.put(id, { id, name: 'stale ' + id }, { expiresAt: 1, source: {} });
	};

	it('serves stale when a source class instance allows it', async function () {
		await expire(ClassSourced, 'class');
		assert.equal((await ClassSourced.get('class')).name, 'stale class');
		assert.equal(sourceCalls, 1, 'the refresh still starts in the background');
		assert.deepEqual(hookCalls, [{ id: 'class', instanceId: 'class', name: 'stale class' }]);
		pendingCalls[0].resolve({ id: 'class', name: 'fresh' });
		await waitFor(() => ClassSourced.primaryStore.getEntry('class')?.value?.name === 'fresh');
	});

	it('serves stale when a plain source object allows it', async function () {
		await expire(ObjectSourced, 'object');
		assert.equal((await ObjectSourced.get('object')).name, 'stale object');
		assert.deepEqual(hookCalls, [{ id: 'object', name: 'stale object' }]);
	});

	it('serves stale when a static hook on the source class allows it', async function () {
		await expire(StaticSourced, 'static');
		assert.equal((await StaticSourced.get('static')).name, 'stale static');
		assert.deepEqual(hookCalls, [{ id: 'static', name: 'stale static' }]);
	});

	it('serves the last good record when the origin fails', async function () {
		await expire(ClassSourced, 'failing');
		assert.equal((await ClassSourced.get('failing')).name, 'stale failing');
		pendingCalls[0].reject(Object.assign(new Error('origin down'), { statusCode: 500 }));
		await waitFor(() => warnings.some((warning) => warning.startsWith('origin down')));
		assert.equal((await ClassSourced.get('failing')).name, 'stale failing');
	});

	it('waits for the source when the source hook declines', async function () {
		allowStale = false;
		await expire(ClassSourced, 'declined');
		const reading = ClassSourced.get('declined');
		await delay(20);
		assert.equal(sourceCalls, 1);
		pendingCalls[0].resolve({ id: 'declined', name: 'fresh declined' });
		assert.equal((await reading).name, 'fresh declined');
	});

	it('lets a hook on the table class take precedence over the source', async function () {
		await expire(ClassSourced, 'table-wins');
		const reading = TableDecides.get('table-wins');
		await delay(20);
		assert.equal(sourceCalls, 1);
		pendingCalls[0].resolve({ id: 'table-wins', name: 'fresh table-wins' });
		assert.equal((await reading).name, 'fresh table-wins');
		assert.deepEqual(hookCalls, [], 'the source hook was not consulted');
	});

	it('lets a hook on the table class decline stale query rows the source would allow', async function () {
		await expire(ClassSourced, 'table-wins-query');
		const searching = (async () => {
			const names = [];
			for await (const record of TableDecides.search({
				conditions: [{ attribute: 'name', value: 'stale table-wins-query' }],
			}))
				names.push(record.name);
			return names;
		})();
		let settled = false;
		searching.then(() => (settled = true));
		await waitFor(() => sourceCalls === 1);
		await delay(20);
		assert.equal(settled, false, 'the query waits for the source');
		pendingCalls[0].resolve({ id: 'table-wins-query', name: 'stale table-wins-query' });
		assert.deepEqual(await searching, ['stale table-wins-query']);
		assert.deepEqual(hookCalls, []);
	});

	it('serves stale query rows when a table subclass allows it', async function () {
		await expire(SubclassAllows, 'subclass-query');
		const names = [];
		for await (const record of SubclassAllows.search({
			conditions: [{ attribute: 'name', value: 'stale subclass-query' }],
		}))
			names.push(record.name);
		assert.deepEqual(names, ['stale subclass-query']);
		assert.equal(sourceCalls, 1);
	});

	it('serves stale query rows when the source allows it', async function () {
		await expire(QuerySourced, 'queried');
		const names = [];
		for await (const record of QuerySourced.search({
			conditions: [{ attribute: 'name', value: 'stale queried' }],
		}))
			names.push(record.name);
		assert.deepEqual(names, ['stale queried']);
		assert.equal(sourceCalls, 1);
		assert.deepEqual(hookCalls, [{ id: 'queried', instanceId: 'queried', name: 'stale queried' }]);
	});

	it('warns once that stale records need an eviction time to stay servable', async function () {
		const evictionWarnings = () => warnings.filter((warning) => warning.includes('has no eviction time'));
		await expire(Evicting, 'kept');
		assert.equal((await Evicting.get('kept')).name, 'stale kept');
		assert.deepEqual(evictionWarnings(), []);
		await expire(Warned, 'first');
		await expire(Warned, 'second');
		assert.equal((await Warned.get('first')).name, 'stale first');
		assert.equal((await Warned.get('second')).name, 'stale second');
		assert.equal(evictionWarnings().length, 1);
		assert.match(evictionWarnings()[0], /SwrOnSourceWarned/);
	});
});
