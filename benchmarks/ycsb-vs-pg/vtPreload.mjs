// Loaded with --import into Harper by run-compare's withHarper when a target sizes the verification
// table. rocksdb-js sizes that table, one per process, when the first database opens, and Harper has no
// setting for it. Harper's main thread opens its databases before it starts any worker, so setting it
// here, before Harper's code runs, covers every thread; a worker repeating the call would throw.
import { isMainThread } from 'node:worker_threads';
import { createRequire } from 'node:module';

if (isMainThread) {
	const raw = process.env.YCSB_VERIFICATION_TABLE_ENTRIES;
	const entries = Number(raw);
	if (!Number.isSafeInteger(entries) || entries < 0) {
		throw new Error(`YCSB_VERIFICATION_TABLE_ENTRIES=${raw} is not a slot count`);
	}
	// The rocksdb-js that Harper itself loads, resolved from its entry script.
	const { RocksDatabase } = createRequire(process.argv[1])('@harperfast/rocksdb-js');
	RocksDatabase.config({ verificationTableEntries: entries });
	process.stderr.write(`[ycsb] verification table sized to ${entries} slots (pid ${process.pid})\n`);
}
