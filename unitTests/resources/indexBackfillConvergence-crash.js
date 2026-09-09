// Child-process half of the crash-resume case in indexBackfillConvergence.test.js: seed a table,
// start an index backfill, and die with SIGKILL as soon as its first checkpoint is persisted,
// leaving the checkpoint key in the marker file. Loaded by the mocha glob too, hence the entry guard.
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

if (require.main === module) {
	const [rootPath, databasePath, database, tableName, markerPath, rowCount] = process.argv.slice(2);
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	// A private root keeps this process off the parent's system database (RocksDB's lock is
	// per process); only the database under test is shared, at the path the parent chose.
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, rootPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(rootPath, 'database'));
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { [database]: { path: databasePath } });
	const { table, resetDatabases, setIndexingCheckpointPeriod } = require('#src/resources/databases');
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	setMainIsWorker(true);
	setIndexingCheckpointPeriod(0);

	mkdirSync(path.join(rootPath, 'database'), { recursive: true });
	const seed = async () => {
		const Tbl = table({
			table: tableName,
			database,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < Number(rowCount); i++) {
			last = Tbl.put({ id: 'c-' + String(i).padStart(6, '0'), tag: 't-' + (i % 7) });
		}
		await last;
	};

	const dieAtFirstCheckpoint = () => {
		resetDatabases();
		const Tbl = table({
			table: tableName,
			database,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const prefix = tableName + '/';
		const poll = () => {
			for (const { key, value } of Tbl.dbisDB.getRange({ start: false })) {
				if (value?.name !== 'tag' || !key.toString().startsWith(prefix)) continue;
				if (value.lastIndexedKey !== undefined) {
					writeFileSync(markerPath, value.lastIndexedKey);
					process.kill(process.pid, 'SIGKILL');
				}
				if (!value.indexingPID) {
					writeFileSync(markerPath, 'COMPLETED');
					process.exit(0);
				}
			}
			setImmediate(poll);
		};
		setImmediate(poll);
	};

	seed().then(dieAtFirstCheckpoint, (error) => {
		console.error(error);
		process.exit(1);
	});
}
