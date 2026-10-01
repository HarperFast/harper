// Child-process half of the crash case in replayCommitBoundaries.test.js; the mocha glob loads it
// too, hence the entry guard.
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

if (require.main === module) {
	const [rootPath, databasePath, database, tableName, markerPath, mode, logKeyArg] = process.argv.slice(2);
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	// A private root keeps this process off the parent's system database; only the database under
	// test is shared, at the path the parent chose.
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, rootPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(rootPath, 'database'));
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { [database]: { path: databasePath } });
	mkdirSync(path.join(rootPath, 'database'), { recursive: true });
	const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
	const replayCommits = [];
	if (mode === 'replay') {
		// installed before the database opens, since opening it is what runs the boot replay
		const { directCommitSync } = DatabaseTransaction.prototype;
		DatabaseTransaction.prototype.directCommitSync = function () {
			if (this.isReplay) replayCommits.push({ timestamp: this.timestamp, writes: this.writes.length });
			return directCommitSync.call(this);
		};
	}
	const { table } = require('#src/resources/databases');
	const { transaction } = require('#src/resources/transaction');
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	setMainIsWorker(true);
	const Tbl = table({
		table: tableName,
		database,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	});

	const writeThenCrash = async () => {
		// Several native commits at one log key, as a replication receiver writes re-deliveries.
		const logKey = Date.now();
		await transaction({ timestamp: logKey }, () => Tbl.put({ id: 'a', n: 1 }));
		await transaction({ timestamp: logKey }, async () => {
			await Tbl.put({ id: 'b', n: 2 });
			await Tbl.put({ id: 'c', n: 3 });
		});
		await transaction({ timestamp: logKey }, () => Tbl.put({ id: 'd', n: 4 }));
		writeFileSync(markerPath, String(logKey));
		// no flush: the writes must be recovered by replaying the transaction log
		process.kill(process.pid, 'SIGKILL');
	};

	const reportReplay = async () => {
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

	(mode === 'write' ? writeThenCrash() : reportReplay()).catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
