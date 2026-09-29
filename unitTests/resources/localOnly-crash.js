// Child-process half of the crash-replay case in localOnly.test.js; the mocha glob loads it too,
// hence the entry guard.
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

if (require.main === module) {
	const [rootPath, databasePath, database, tableName, markerPath, mode] = process.argv.slice(2);
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	// A private root keeps this process off the parent's system database; only the database under
	// test is shared, at the path the parent chose.
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, rootPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(rootPath, 'database'));
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { [database]: { path: databasePath } });
	mkdirSync(path.join(rootPath, 'database'), { recursive: true });
	const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
	const replayed = {};
	if (mode === 'replay') {
		// installed before the database opens, since opening it is what runs the boot replay
		const { directCommitSync } = DatabaseTransaction.prototype;
		DatabaseTransaction.prototype.directCommitSync = function () {
			if (!this.isReplay) return directCommitSync.call(this);
			const applied = this.writes.filter((write) => !write.skipped);
			for (const { key, store } of applied)
				replayed[key] ??= { commits: 0, absentBeforeReplay: store.getEntry(key) === undefined };
			const result = directCommitSync.call(this);
			for (const { key } of applied) replayed[key].commits++;
			return result;
		};
	}
	const { table } = require('#src/resources/databases');
	const { transaction } = require('#src/resources/transaction');
	const { LOCAL_ONLY } = require('#src/resources/auditStore');
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	setMainIsWorker(true);
	const Rows = table({
		table: tableName,
		database,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	});

	const put = (id, n, options) => {
		const context = {};
		return transaction(context, async () => {
			const resource = await Rows.getResource(id, context);
			resource._writeUpdate(id, { id, n }, true, options);
			await resource.save();
		});
	};
	const remove = (id, options) => {
		const context = {};
		return transaction(context, async () => {
			const resource = await Rows.getResource(id, context);
			resource._writeDelete(id, options);
		});
	};

	const writeThenCrash = async () => {
		await put('local-put', 1, { localOnly: true });
		await put('local-delete', 2, { localOnly: true });
		await remove('local-delete', { localOnly: true });
		await put('plain', 3);
		writeFileSync(markerPath, 'written');
		// no flush: the rows must come back through the boot replay of the transaction log
		process.kill(process.pid, 'SIGKILL');
	};

	const reportReplay = () => {
		const rows = {};
		for (const id of ['local-put', 'local-delete', 'plain']) {
			const entry = Rows.primaryStore.getEntry(id);
			rows[id] = { present: entry?.value != null, localOnly: Boolean(entry?.metadataFlags & LOCAL_ONLY) };
		}
		writeFileSync(markerPath, JSON.stringify({ replayed, rows }));
		process.exit(0);
	};

	(mode === 'write' ? writeThenCrash() : Promise.resolve().then(reportReplay)).catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
