require('../../mocha.init.js');
const { RocksDatabase } = require('../../rocksdbBindings.mts').rocksdbBindings();
require('#src/resources/RocksTransactionLogStore');

const db = RocksDatabase.open(process.argv[2], { disableWAL: true });
db.putSync('key', 'value');
process.exit(0);
