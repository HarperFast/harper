// Child-process half of the crash case in retryAuditChain.test.js; the mocha glob loads it too, hence the
// entry guard.
const path = require('node:path');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');

if (require.main === module) {
	const [rootPath, databasePath, markerPath, mode] = process.argv.slice(2);
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	// A private root keeps this process off the parent's system database; only the database under test is
	// shared, at the path the parent chose.
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, rootPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(rootPath, 'database'));
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { retrycrash: { path: databasePath } });
	mkdirSync(path.join(rootPath, 'database'), { recursive: true });
	const { Transaction } = require('@harperfast/rocksdb-js');
	const { table } = require('#src/resources/databases');
	const { transaction } = require('#src/resources/transaction');
	const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
	const { setMainIsWorker } = require('#src/server/threads/manageThreads');
	setMainIsWorker(true);
	const Tbl = table({
		table: 'Rows',
		database: 'retrycrash',
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'meta' }],
	});
	const origin = getIdOfRemoteNode('retry-crash-origin', Tbl.auditStore);
	const applyFromOrigin = (version, record, fullUpdate = false) => {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			const resource = await Tbl.getResource('r', context);
			await resource._writeUpdate('r', record, fullUpdate, { isNotification: true, nodeId: origin, version });
		});
	};

	const writeThenCrash = async () => {
		const base = Date.now() + 86_400_000;
		writeFileSync(markerPath, String(base));
		await applyFromOrigin(base, { id: 'r', title: 'seed', meta: 'seed' }, true);
		const db = Tbl.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		let intercepted = false;
		Transaction.prototype.commit = async function (...args) {
			if (intercepted || this.store?.db !== db) return originalCommit.apply(this, args);
			intercepted = true;
			await applyFromOrigin(base + 200, { title: 'intermediate' });
			// durable up to the intermediate head; the retried write below lives only in its log entry
			await Tbl.primaryStore.rootStore.flush();
			return originalCommit.apply(this, args);
		};
		await applyFromOrigin(base + 300, { meta: 'retried' });
		process.kill(process.pid, 'SIGKILL');
	};

	const reportReplay = async () => {
		const base = Number(readFileSync(markerPath, 'utf8'));
		const replayed = (await Tbl.get('r'))?.meta === 'retried';
		await applyFromOrigin(base + 100, { title: 'older' });
		const { title, meta } = await Tbl.get('r');
		writeFileSync(markerPath, JSON.stringify({ replayed, title, meta }));
		process.exit(0);
	};

	(mode === 'write' ? writeThenCrash() : reportReplay()).catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
