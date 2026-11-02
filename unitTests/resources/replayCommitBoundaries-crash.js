// Child-process half of the crash case in replayCommitBoundaries.test.js; the mocha glob loads it
// too, hence the entry guard.
const path = require('node:path');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const assert = require('node:assert');

if (require.main === module) {
	const [rootPath, databasePath, database, tableName, markerPath, mode, logKeyArg] = process.argv.slice(2);
	if (mode.includes('advice')) {
		process.env.ROOTPATH = rootPath;
		mkdirSync(rootPath, { recursive: true });
		writeFileSync(
			path.join(rootPath, 'harper-config.yaml'),
			`rootPath: ${JSON.stringify(rootPath)}\nlogging:\n  file: false\n  stdStreams: true\n  level: warn\n`
		);
	}
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	// A private root keeps this process off the parent's system database; only the database under
	// test is shared, at the path the parent chose.
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, rootPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(rootPath, 'database'));
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { [database]: { path: databasePath } });
	if (mode === 'replay-advice') env.setProperty(terms.CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT, 0.000001);
	mkdirSync(path.join(rootPath, 'database'), { recursive: true });
	const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
	const replayCommits = [];
	const heapSamples = [];
	const staleRecordCount = 10000;
	if (mode.startsWith('replay')) {
		// installed before the database opens, since opening it is what runs the boot replay
		const { directCommitSync } = DatabaseTransaction.prototype;
		DatabaseTransaction.prototype.directCommitSync = function () {
			let commit;
			if (this.isReplay) {
				replayCommits.push((commit = { timestamp: this.timestamp, writes: this.writes.length }));
				if (mode === 'replay-stale' && [1000, 9000].includes(replayCommits.length)) {
					global.gc();
					heapSamples.push(process.memoryUsage().heapUsed);
				}
			}
			const result = directCommitSync.call(this);
			if (commit) commit.succeeded = true;
			return result;
		};
	}
	const { table } = require('#src/resources/databases');
	const { transaction } = require('#src/resources/transaction');
	const { setMainIsWorker } = require('#src/server/threads/manageThreads');
	setMainIsWorker(true);
	const Tbl = table({
		table: tableName,
		database,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	});

	const writeThenCrash = async () => {
		if (mode.startsWith('write-advice')) {
			await Tbl.put({ id: 'seed', n: -1 });
			await Tbl.primaryStore.rootStore.flush();
			const statePath = path.join(Tbl.primaryStore.rootStore.path, 'transaction_logs', 'local', 'txn.state');
			writeFileSync(markerPath + '.state', readFileSync(statePath));
			for (let n = 0; n < 3; n++) await Tbl.put({ id: String(n), n });
			await Tbl.primaryStore.rootStore.flush();
			if (mode === 'write-advice-tail') await Tbl.put({ id: 'tail', n: 3 });
			process.kill(process.pid, 'SIGKILL');
			return;
		}
		if (mode === 'write-stale') {
			await Tbl.put({ id: 'seed', n: -1 });
			await Tbl.primaryStore.rootStore.flush();
			const statePath = path.join(Tbl.primaryStore.rootStore.path, 'transaction_logs', 'local', 'txn.state');
			writeFileSync(markerPath + '.state', readFileSync(statePath));
			for (let n = 0; n < staleRecordCount; n++) await Tbl.put({ id: String(n), n, payload: 'x'.repeat(8192) });
			await Tbl.primaryStore.rootStore.flush();
			await Tbl.put({ id: 'tail', n: staleRecordCount });
			process.kill(process.pid, 'SIGKILL');
			return;
		}
		if (mode === 'write-explicit') {
			await Tbl.put({ id: 'x', n: 0 });
			const version = Date.now() + 60_000;
			await Tbl.patch('x', { n: 1 }, { timestamp: version });
			writeFileSync(markerPath, String(version));
			// no flush: the explicit-timestamp patch, minted a key below its version, is recovered by replay
			process.kill(process.pid, 'SIGKILL');
			return;
		}
		// Several native commits at one log key in an origin's log, as a replication receiver writes
		// re-deliveries (the node's own `local` log never repeats a key).
		const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
		const { RequestTarget } = require('#src/resources/RequestTarget');
		Tbl.auditStore.ensureLogExists('peer-crash');
		const peerId = getIdOfRemoteNode('peer-crash', Tbl.auditStore);
		const logKey = Date.now();
		const commit = (records) => {
			const context = { timestamp: logKey };
			return transaction(context, () => {
				for (const record of records) {
					const target = new RequestTarget();
					target.id = null;
					const resource = Tbl.getResource(target, context, {});
					resource._writeUpdate(record.id, record, true, { context, nodeId: peerId, version: logKey });
					resource.save();
				}
			});
		};
		await commit([{ id: 'a', n: 1 }]);
		await commit([
			{ id: 'b', n: 2 },
			{ id: 'c', n: 3 },
		]);
		await commit([{ id: 'd', n: 4 }]);
		writeFileSync(markerPath, String(logKey));
		// no flush: the writes must be recovered by replaying the transaction log
		process.kill(process.pid, 'SIGKILL');
	};

	const reportReplay = async () => {
		if (mode.startsWith('replay-advice')) {
			const rows = [];
			for (let n = 0; n < 3; n++) rows.push((await Tbl.get(String(n)))?.n);
			writeFileSync(markerPath, JSON.stringify({ rows, tail: (await Tbl.get('tail'))?.n ?? null }));
			process.exit(0);
		}
		if (mode === 'replay-stale') {
			let rowCount = 0;
			for (const { key, value } of Tbl.primaryStore.getRange()) {
				if (key === 'seed') assert.strictEqual(value.n, -1);
				else if (key === 'tail') assert.strictEqual(value.n, staleRecordCount);
				else {
					assert.strictEqual(value.n, Number(key));
					assert.strictEqual(value.payload, 'x'.repeat(8192));
				}
				rowCount++;
			}
			writeFileSync(markerPath, JSON.stringify({ commits: replayCommits.length, heapSamples, rowCount }));
			process.exit(0);
		}
		if (mode === 'replay-explicit') {
			const version = Number(logKeyArg);
			const entry = Tbl.primaryStore.getEntry('x');
			let headKey;
			for (const auditEntry of Tbl.auditStore.getRange({ start: 1, log: 0 }))
				if (auditEntry.recordId === 'x' && auditEntry.version === version) headKey = auditEntry.txnLogKey;
			await Tbl.patch('x', { n: 2 }, { timestamp: version - 1000 });
			writeFileSync(
				markerPath,
				JSON.stringify({
					replayed: replayCommits.some(({ timestamp, succeeded }) => timestamp === headKey && succeeded),
					version: entry.version === version,
					headRef: entry.additionalAuditRefs?.some((ref) => ref.version === headKey) ?? false,
					n: (await Tbl.get('x')).n,
				})
			);
			process.exit(0);
		}
		const logKey = Number(logKeyArg);
		const rows = {};
		for (const id of ['a', 'b', 'c', 'd']) rows[id] = (await Tbl.get(id))?.n;
		writeFileSync(
			markerPath,
			JSON.stringify({
				commits: replayCommits.filter(({ timestamp }) => timestamp === logKey).map(({ writes }) => writes),
				rows,
			})
		);
		process.exit(0);
	};

	(mode.startsWith('write') ? writeThenCrash() : reportReplay()).catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
