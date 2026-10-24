require('../../testUtils');
const assert = require('node:assert');
const { parentPort, workerData } = require('node:worker_threads');
const { setupTestDBPath } = require('../../testUtils');
const { table, resetDatabases, databases, openReplicaDeadlineStore } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { Resource } = require('#src/resources/Resource');
const { REPLICA, setMinReplicaScanIntervalForTesting } = require('#src/resources/Table');
const { server } = require('#src/server/Server');
const { onMessageByType } = require('#js/server/threads/manageThreads');
const { schemaHandler } = require('#js/server/itc/serverHandlers');
const { SchemaEventMsg } = require('#js/server/threads/itc');
const { waitFor } = require('../../waitFor');

const { database, role, sourcePort } = workerData;
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const CONTROL = 'replica-options-control';
const REPLY = 'replica-options-reply';
let tableName;
let Records;
let sourceCalls = 0;
let admissions = [];
let sourceId = 0;
const pendingSources = new Map();

setupTestDBPath();
// above the 50ms rescan cadence, so a rescan that restarted the sweep timer would postpone it indefinitely
setMinReplicaScanIntervalForTesting(300);
onMessageByType(CONTROL, () => {});
sourcePort.on('message', (message) => {
	if (role === 'writer') {
		sourcePort.postMessage({
			id: message.id,
			entry: {
				key: message.key,
				version: message.version,
				value: { id: message.key, name: 'resident', body: 'complete' },
				originNode: server.hostname,
			},
		});
	} else {
		pendingSources.get(message.id)?.(message.entry);
	}
});

function fetchFromWriter(entry) {
	const id = ++sourceId;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSources.delete(id);
			reject(new Error('resident worker did not answer'));
		}, 5000);
		pendingSources.set(id, (answer) => {
			clearTimeout(timer);
			pendingSources.delete(id);
			resolve(answer);
		});
		sourcePort.postMessage({ id, key: entry.key, version: entry.version });
	});
}

function deadlineStore() {
	if (isLMDB || !Records.dbisDB.getSync(`${tableName}/@replicas`)) return;
	return openReplicaDeadlineStore(Records.primaryStore.rootStore, tableName, Records.storageGeneration);
}

function snapshot(key) {
	const entry = key === undefined ? undefined : Records.primaryStore.getEntry(key);
	const state = new Int32Array(
		Records.primaryStore.getUserSharedBuffer(`replica-sweep:${Records.tableId}`, new ArrayBuffer(8))
	);
	return {
		flags: entry?.metadataFlags,
		value: entry?.value,
		deadline: key === undefined ? undefined : deadlineStore()?.getSync(key),
		armed: Atomics.load(state, 1),
		expirationMS: Records.expirationMS,
		evictionMS: Records.evictionMS,
	};
}

async function handle({ command, table: name, key, options, deadline, expectRenewal }) {
	switch (command) {
		case 'init':
			tableName = name;
			Records = resetDatabases()[database][tableName];
			assert.ok(Records);
			if (role === 'reader') {
				Records.sourcedFrom(
					class extends Resource {
						static async load(request) {
							sourceCalls++;
							const answer = await fetchFromWriter(request);
							admissions.push(await Records._storeReplica(request, answer));
							return answer;
						}
					},
					{ intermediateSource: true }
				);
			}
			return snapshot();
		case 'configure': {
			assert.equal(role, 'writer');
			const Updated = table({ database, table: tableName, attributes: Records.attributes, ...options });
			await Updated.dbisDB.committed;
			const primary = Updated.dbisDB.getSync(`${tableName}/`);
			return { replicaExpiration: primary.replicaExpiration, replicaRefreshFraction: primary.replicaRefreshFraction };
		}
		case 'rescan': {
			await schemaHandler({
				type: 'schema',
				message: new SchemaEventMsg(process.pid, 'schema-change', database, tableName),
			});
			assert.strictEqual(databases[database][tableName], Records, 'the rescan must reuse the loaded class');
			const primary = Records.dbisDB.getSync(`${tableName}/`);
			return {
				...snapshot(key),
				replicaExpiration: primary.replicaExpiration,
				replicaRefreshFraction: primary.replicaRefreshFraction,
			};
		}
		case 'read': {
			if (!Records.primaryStore.getEntry(key)) {
				Records.dbisDB.putSync([Symbol.for('residency_by_id'), 123], ['resident-a']);
				const context = {};
				await transaction(context, async () => {
					const resource = await Records.getResource(key, context, { ensureLoaded: false });
					resource._writeInvalidate(key, { name: 'stub' }, { residencyId: 123 });
				});
			}
			const callsBefore = sourceCalls;
			admissions = [];
			const start = Date.now();
			assert.equal((await Records.get(key)).body, 'complete');
			assert.equal((await Records.get(key)).body, 'complete');
			return { ...snapshot(key), calls: sourceCalls - callsBefore, admissions, start, end: Date.now() };
		}
		case 'deadline':
			await deadlineStore()?.put(key, deadline);
			return snapshot(key);
		case 'renew':
			assert.equal((await Records.get(key)).body, 'complete');
			if (expectRenewal)
				await waitFor(() => deadlineStore().getSync(key) > deadline, {
					timeout: 3000,
					message: 'the rescanned refresh fraction renews the replica',
				});
			return snapshot(key);
		case 'sweep-through-rescans': {
			let rescans = 0;
			await waitFor(
				async () => {
					await handle({ command: 'rescan' });
					rescans++;
					return !(Records.primaryStore.getEntry(key)?.metadataFlags & REPLICA);
				},
				{ timeout: 3500, interval: 50, message: 'unchanged rescans must not postpone the replica sweep' }
			);
			await waitFor(() => snapshot().armed === 0, { timeout: 2500, message: 'the empty sweep stands down' });
			await handle({ command: 'rescan' });
			return { ...snapshot(key), rescans };
		}
		case 'close':
			await Records.closeMaintenance();
			return {};
		default:
			throw new Error(`Unknown fixture command ${command}`);
	}
}

parentPort.on('message', async (message) => {
	if (message.type !== CONTROL) return;
	try {
		parentPort.postMessage({ type: REPLY, id: message.id, result: await handle(message) });
	} catch (error) {
		parentPort.postMessage({ type: REPLY, id: message.id, error: error.stack });
	}
});
parentPort.ref();
