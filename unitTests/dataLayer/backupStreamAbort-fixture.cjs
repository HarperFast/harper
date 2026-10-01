'use strict';

// Aborts a get_backup download and then lets the process run out of work. If the consumer abort did
// not tear the native producer down, the binding stays blocked writing into a stream nobody drains
// and this process never exits — which is the whole point of the test that spawns it. Lives in a
// child process because the leak is a native producer, not a libuv handle: it is invisible to
// `process.getActiveResourcesInfo()` and to anything else observable in-process.

const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { createBackupStream } = require('#src/dataLayer/rocksdbBackup');

const root = mkdtempSync(join(tmpdir(), 'harper.unit-test.backup-abort-'));
const dir = join(root, 'db');
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const seed = RocksDatabase.open(dir);
try {
	// enough bytes that the native backup is still producing when the consumer goes away
	for (let i = 0; i < 2000; i++) seed.putSync(`k${i}`, { payload: 'x'.repeat(4096) });
} finally {
	seed.close();
}

const store = RocksDatabase.open(dir);
const stream = createBackupStream(store, 'db', false, true);
// what a client disconnecting mid-download does to the response stream
stream.destroy(new Error('client went away'));
