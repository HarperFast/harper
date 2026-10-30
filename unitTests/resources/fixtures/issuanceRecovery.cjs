require('../../mocha.init.js');
const fs = require('node:fs');
const { RocksDatabase } = require('../../rocksdbBindings.mts').rocksdbBindings();
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { seedLocalIssuance, claimLocalKey, freshLocalKey } = require('#src/resources/originClosedFloor');
const { coverLocalIssuance, readLocalIssuanceCeiling } = require('#src/resources/auditStore');

const [mode, root] = process.argv.slice(2);
const db = RocksDatabase.open(root, { writeBufferSize: 64 * 1024 * 1024 });
const audit = new RocksTransactionLogStore(db);
const recoveredCeiling = readLocalIssuanceCeiling(audit);
const initialSstFiles = fs.readdirSync(root).filter((name) => name.endsWith('.sst'));
seedLocalIssuance(db, recoveredCeiling, (key) => coverLocalIssuance(audit, key));
const key =
	mode === 'issue' ? claimLocalKey(db, Math.max(Date.now(), db.getMonotonicTimestamp()) + 60_000) : freshLocalKey(db);
const result = {
	type: 'issuance-result',
	key,
	ceiling: readLocalIssuanceCeiling(audit),
	recoveredCeiling,
	initialSstFiles,
};
if (mode === 'issue') {
	process.on('message', () => {});
	process.send(result);
} else {
	process.send(result, () => {
		db.close();
		process.exit(0);
	});
}
