// harper#2711: the send-side filters live in harper-pro, so these tests assert the LOCAL_ONLY bit, not the wire.
require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

describe('local-only writes (harper#2711)', () => {
	let dbPath, Rows, auditStore;

	before(function () {
		dbPath = setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			table: 'LocalOnlyWrites',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
			audit: true,
		});
		auditStore = Rows.primaryStore.rootStore.auditStore;
	});

	function newestEntry(id, type) {
		let newest;
		for (const entry of auditStore.getRange({ start: 1 })) {
			if (entry.tableId === Rows.tableId && entry.recordId === id && entry.type === type) newest = entry;
		}
		return newest;
	}

	function writeThrough(id, stage) {
		const context = {};
		return transaction(context, async () => {
			const resource = await Rows.getResource(id, context);
			await stage(resource);
		});
	}

	const writes = {
		delete: { type: 'delete', stage: (resource, id, options) => resource._writeDelete(id, options) },
		invalidate: {
			type: 'invalidate',
			stage: (resource, id, options) => resource._writeInvalidate(id, undefined, options),
		},
		relocate: { type: 'relocate', stage: (resource, id, options) => resource._writeRelocate(id, options) },
		publish: {
			type: 'message',
			stage: (resource, id, options) => resource._writePublish(id, { text: 'to ' + id }, options),
		},
	};

	for (const [name, { type, stage }] of Object.entries(writes)) {
		it(`marks a local-only ${name} on both the audit entry and the record metadata`, async function () {
			const id = `local-${name}`;
			await Rows.put({ id, name: 'row' });
			await writeThrough(id, (resource) => stage(resource, id, { localOnly: true }));

			const entry = newestEntry(id, type);
			assert.ok(entry, `an audit entry of type ${type} was written`);
			assert.strictEqual(entry.extendedType & LOCAL_ONLY, LOCAL_ONLY, 'the audit entry carries LOCAL_ONLY');
			const stored = Rows.primaryStore.getEntry(id);
			assert.ok(stored, 'the write left a stored entry (a tombstone, for a delete)');
			assert.strictEqual(stored.metadataFlags & LOCAL_ONLY, LOCAL_ONLY, 'the record metadata carries LOCAL_ONLY');
		});

		it(`leaves a plain ${name} replicable`, async function () {
			const id = `plain-${name}`;
			await Rows.put({ id, name: 'row' });
			await writeThrough(id, (resource) => stage(resource, id, {}));

			const entry = newestEntry(id, type);
			assert.ok(entry, `an audit entry of type ${type} was written`);
			assert.strictEqual(entry.extendedType & LOCAL_ONLY, 0, 'no LOCAL_ONLY on the audit entry');
			assert.strictEqual(Rows.primaryStore.getEntry(id).metadataFlags & LOCAL_ONLY, 0, 'no LOCAL_ONLY on the record');
		});
	}

	describeUnlessLmdb('crash replay', () => {
		async function runCrashChild(args) {
			const child = spawn(process.execPath, [path.join(__dirname, 'localOnly-crash.js'), ...args], {
				stdio: ['ignore', 'ignore', 'pipe'],
			});
			let stderr = '';
			child.stderr.on('data', (chunk) => (stderr += chunk));
			const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
			try {
				return await new Promise((resolve, reject) => {
					child.once('error', reject);
					child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
				});
			} finally {
				clearTimeout(timer);
			}
		}

		it('keeps the local-only bit on a replayed put and a replayed delete', async function () {
			const crashDir = path.join(dbPath, 'local-only-crash');
			rmSync(crashDir, { recursive: true, force: true });
			const sharedPath = path.join(crashDir, 'shared');
			const markerPath = path.join(crashDir, 'marker');
			const childArgs = [sharedPath, 'localonlyreplay', 'Rows', markerPath];
			const written = await runCrashChild([path.join(crashDir, 'writer-root'), ...childArgs, 'write']);
			assert.strictEqual(
				written.signal,
				'SIGKILL',
				`the writer should kill itself (exit ${written.code}): ${written.stderr}`
			);
			assert.strictEqual(readFileSync(markerPath, 'utf8'), 'written');

			const replayer = await runCrashChild([path.join(crashDir, 'replayer-root'), ...childArgs, 'replay']);
			assert.strictEqual(replayer.code, 0, replayer.stderr);
			const { replayed, rows } = JSON.parse(readFileSync(markerPath, 'utf8'));
			assert.deepStrictEqual(
				replayed,
				{
					'local-put': { commits: 1, absentBeforeReplay: true },
					'local-delete': { commits: 2, absentBeforeReplay: true },
					'plain': { commits: 1, absentBeforeReplay: true },
				},
				'replay committed each row into a store that did not hold it'
			);
			assert.deepStrictEqual(rows, {
				'local-put': { present: true, localOnly: true },
				'local-delete': { present: false, localOnly: true },
				'plain': { present: true, localOnly: false },
			});
		});
	});
});
