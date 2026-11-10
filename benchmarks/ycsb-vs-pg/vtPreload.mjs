// Loaded with --import into Harper by run-compare's withHarper when a target pins the verification
// table. rocksdb-js has one table per process, sized before it is first used. Harper sizes it itself on
// its main thread's first open, from storage.recordCacheSize and its thread count, so this sets the
// target's size first and drops Harper's later request: the target measures exactly this slot count.
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
	const config = RocksDatabase.config;
	RocksDatabase.config = function (options) {
		if (options && 'verificationTableEntries' in options) {
			const { verificationTableEntries: _harperSize, ...rest } = options;
			options = rest;
		}
		return config.call(this, options);
	};
	process.stderr.write(`[ycsb] verification table pinned to ${entries} slots (pid ${process.pid})\n`);
}
