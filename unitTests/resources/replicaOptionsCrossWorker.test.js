require('../testUtils');
const assert = require('node:assert');
const { Worker, MessageChannel } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { INVALIDATED, REPLICA } = require('#src/resources/Table');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
// not one of the databases testUtils aliases onto one path: each alias would load its own class and sweep
const DATABASE = 'replicaOptions';

function fixtureWorker(role, sourcePort) {
	const worker = new Worker(__dirname + '/fixtures/replicaOptionsWorker.cjs', {
		workerData: {
			database: DATABASE,
			role,
			sourcePort,
			noServerStart: true,
			addPorts: [],
			workerIndex: role === 'reader' ? 1 : 0,
			workerCount: 2,
		},
		transferList: [sourcePort],
	});
	let nextId = 0;
	const pending = new Map();
	worker.on('message', (message) => {
		if (message.type !== 'replica-options-reply') return;
		pending.get(message.id)?.(message.error ? new Error(message.error) : null, message.result);
	});
	const fail = (error) => {
		for (const settle of pending.values()) settle(error);
	};
	worker.on('error', fail);
	worker.on('exit', (code) => fail(new Error(`fixture worker exited: ${code}`)));
	return {
		worker,
		call(command, details = {}) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => pending.get(id)?.(new Error(`worker command timed out: ${command}`)), 15000);
				pending.set(id, (error, result) => {
					clearTimeout(timer);
					pending.delete(id);
					if (error) reject(error);
					else resolve(result);
				});
				worker.postMessage({ type: 'replica-options-control', id, command, ...details });
			});
		},
	};
}

// one worker pair for the suite: a worker's startup costs more than each test
let reader, writer;

async function withTable(name, options, run) {
	table({
		database: DATABASE,
		table: name,
		audit: true,
		expiration: 600,
		eviction: 1200,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
		...options,
	});
	try {
		await Promise.all([writer.call('init', { table: name }), reader.call('init', { table: name })]);
		await run(reader, writer);
	} finally {
		await Promise.allSettled([reader.call('close'), writer.call('close')]);
	}
}

function assertReads(result, lifetime) {
	const stores = !isLMDB && lifetime > 0;
	assert.equal(result.calls, stores ? 1 : 2, 'the second read uses a replica only when admission is enabled');
	assert.deepEqual(result.admissions, stores ? [true] : [false, false]);
	assert.equal(Boolean(result.flags & REPLICA), stores);
	assert.equal(Boolean(result.flags & INVALIDATED), !stores);
	if (stores) {
		assert.ok(result.deadline >= result.start + lifetime * 1000, 'admission uses the new lifetime');
		assert.ok(result.deadline <= result.end + lifetime * 1000, 'deadline stays within the admission window');
	} else assert.equal(result.deadline, undefined);
	assert.equal(result.expirationMS, 600000);
	assert.equal(result.evictionMS, 1200000);
}

async function updateAndRescan(writer, reader, options, key) {
	const persisted = await writer.call('configure', { options });
	for (const [name, value] of Object.entries(options)) assert.equal(persisted[name], value);
	const rescanned = await reader.call('rescan', { key });
	for (const [name, value] of Object.entries(options)) assert.equal(rescanned[name], value);
	assert.equal(rescanned.expirationMS, 600000);
	assert.equal(rescanned.evictionMS, 1200000);
	return rescanned;
}

describe('Replica options across worker schema rescans', function () {
	this.timeout(60000);
	before(() => {
		setupTestDBPath();
		const { port1, port2 } = new MessageChannel();
		writer = fixtureWorker('writer', port1);
		reader = fixtureWorker('reader', port2);
	});
	after(() => Promise.all([reader?.worker.terminate(), writer?.worker.terminate()]));

	it('applies an enabling lifetime to the next remote read without replacing the class', async () => {
		await withTable(
			'ReplicaOptionsEnable',
			{ replicaExpiration: 0, replicaRefreshFraction: 1 },
			async (reader, writer) => {
				assertReads(await reader.call('read', { key: 'before' }), 0);
				await updateAndRescan(writer, reader, { replicaExpiration: 60 });
				assertReads(await reader.call('read', { key: 'after' }), 60);
			}
		);
	});

	it('stops admissions on disable and retains an existing replica and deadline', async () => {
		await withTable(
			'ReplicaOptionsDisable',
			{ replicaExpiration: 60, replicaRefreshFraction: 1 },
			async (reader, writer) => {
				const before = await reader.call('read', { key: 'before' });
				assertReads(before, 60);
				assert.equal(before.armed, isLMDB ? 0 : 1);
				const after = await updateAndRescan(writer, reader, { replicaExpiration: 0 }, 'before');
				assert.equal(after.flags, before.flags);
				assert.equal(after.deadline, before.deadline);
				assert.equal(after.armed, 0);
				assertReads(await reader.call('read', { key: 'after' }), 0);
			}
		);
	});

	it('applies changed lifetime and refresh fraction to admissions and read renewal', async () => {
		await withTable(
			'ReplicaOptionsRefresh',
			{ replicaExpiration: 60, replicaRefreshFraction: 1 },
			async (reader, writer) => {
				assertReads(await reader.call('read', { key: 'before' }), 60);
				const deadline = Date.now() + 10000;
				if (!isLMDB) {
					await reader.call('deadline', { key: 'before', deadline });
					assert.equal((await reader.call('renew', { key: 'before' })).deadline, deadline);
				}
				await updateAndRescan(writer, reader, { replicaExpiration: 120, replicaRefreshFraction: 0.25 });
				assertReads(await reader.call('read', { key: 'after' }), 120);
				if (!isLMDB) {
					const renewed = await reader.call('renew', { key: 'before', deadline, expectRenewal: true });
					assert.ok(renewed.deadline > deadline);
				} else assertReads(await reader.call('read', { key: 'before' }), 0);
			}
		);
	});

	it('keeps sweeping through unchanged schema rescans and stays stood down afterward', async function () {
		if (isLMDB) this.skip();
		await withTable('ReplicaOptionsSweep', { replicaExpiration: 0.2, replicaRefreshFraction: 1 }, async (reader) => {
			assertReads(await reader.call('read', { key: 'expires' }), 0.2);
			const result = await reader.call('sweep-through-rescans', { key: 'expires' });
			assert.ok(result.rescans > 1);
			assert.ok(result.flags & INVALIDATED);
			assert.equal(result.deadline, undefined);
			assert.equal(result.armed, 0);
		});
	});
});
