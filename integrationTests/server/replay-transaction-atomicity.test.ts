/**
 * A corrupt transaction-log frame in the middle of a source transaction must not leave that
 * transaction half-applied.
 *
 * Replay groups every equal-version entry into one transaction and commits it at the next version
 * boundary, so a break inside such a group used to commit whatever part of it was still readable —
 * a transaction that never committed that way at the source becoming durable here. This drives a
 * real multi-record insert, tears the log inside it, and requires the replayed table to hold all of
 * that insert or none of it. See HarperFast/harper#2016 and #2063.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual as equal } from 'node:assert';
import { readdirSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	type HarperContext,
} from '@harperfast/integration-testing';
import { constants } from '@harperfast/rocksdb-js';

// Transaction-log framing (big-endian): a fixed-size file header, then entries shaped
// [float64 timestamp][uint32 length][flags byte][length bytes of data].
const { TRANSACTION_LOG_FILE_HEADER_SIZE, TRANSACTION_LOG_ENTRY_HEADER_SIZE } = constants;

const DB = 'atomicity';
const TABLE = 'orders';
const EARLIER_IDS = 60;
const TORN_IDS = 60;
// Entries of the torn transaction left readable before the break, so the test proves the readable
// part is discarded rather than proving the whole transaction was unreachable anyway.
const READABLE_BEFORE_BREAK = 10;

async function op(ctx: HarperContext, body: any) {
	return await sendOperation(ctx, { ...body, authorization: ctx.admin });
}

function records(start: number, count: number) {
	const out = [];
	for (let i = 0; i < count; i++) out.push({ id: start + i, payload: 'x'.repeat(256), n: i });
	return out;
}

async function countInRange(ctx: HarperContext, start: number, count: number): Promise<number> {
	const rows = await op(ctx, {
		operation: 'sql',
		sql: `select count(*) as c from ${DB}.${TABLE} where id >= ${start} and id < ${start + count}`,
	});
	return rows[0]?.c ?? 0;
}

function userTxnLogFiles(dataRootDir: string): string[] {
	const out: string[] = [];
	const dbRoot = join(dataRootDir, 'database');
	for (const db of readdirSync(dbRoot)) {
		if (db === 'system') continue;
		const tlogRoot = join(dbRoot, db, 'transaction_logs');
		let nodes: string[];
		try {
			nodes = readdirSync(tlogRoot);
		} catch {
			continue;
		}
		for (const node of nodes) {
			for (const file of readdirSync(join(tlogRoot, node))) {
				if (file.endsWith('.txnlog')) out.push(join(tlogRoot, node, file));
			}
		}
	}
	return out;
}

/**
 * Break the framing partway through the log's LAST transaction — the run of trailing entries that
 * share the highest timestamp — leaving `readableBefore` of its entries intact ahead of the break.
 * Returns how many entries that transaction has, or 0 if the log has no such run to tear.
 */
function tearLastTransaction(path: string, readableBefore: number): number {
	const buf = readFileSync(path);
	const entries: { lengthPos: number; timestamp: number }[] = [];
	let pos = TRANSACTION_LOG_FILE_HEADER_SIZE;
	while (pos + TRANSACTION_LOG_ENTRY_HEADER_SIZE <= buf.length) {
		const timestamp = buf.readDoubleBE(pos);
		if (timestamp === 0) break; // a zero timestamp marks end-of-log to the reader
		const lengthPos = pos + 8;
		const length = buf.readUInt32BE(lengthPos);
		const next = pos + TRANSACTION_LOG_ENTRY_HEADER_SIZE + length;
		if (length === 0 || next > buf.length) break;
		entries.push({ lengthPos, timestamp });
		pos = next;
	}
	if (entries.length === 0) return 0;
	const lastTimestamp = entries.at(-1).timestamp;
	let first = entries.length - 1;
	while (first > 0 && entries[first - 1].timestamp === lastTimestamp) first--;
	const transactionEntries = entries.length - first;
	if (transactionEntries <= readableBefore) return 0;
	// Force this entry's declared length to overrun the log (top byte → 0xff, ≥ 4 GB): the reader
	// throws a bounded RangeError there and cannot locate any entry after it.
	const fd = openSync(path, 'r+');
	try {
		writeSync(fd, Buffer.from([0xff]), 0, 1, entries[first + readableBefore].lengthPos);
	} finally {
		closeSync(fd);
	}
	return transactionEntries;
}

suite('Replay transaction atomicity across a corrupt frame', (ctx: ContextWithHarper) => {
	before(async () => {
		// Don't flush on exit: the crash must leave these writes recoverable only from the txn log.
		await startHarper(ctx, { env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		await op(ctx.harper, { operation: 'create_database', database: DB });
		await op(ctx.harper, { operation: 'create_table', database: DB, table: TABLE, primary_key: 'id' });
	});
	after(async () => teardownHarper(ctx));

	test('discards a transaction the corrupt frame truncated instead of applying part of it', async () => {
		await op(ctx.harper, { operation: 'insert', database: DB, table: TABLE, records: records(1, EARLIER_IDS) });
		// The last insert is one source transaction, and is the one the tear lands inside.
		await op(ctx.harper, { operation: 'insert', database: DB, table: TABLE, records: records(1001, TORN_IDS) });

		const dataRootDir = ctx.harper.dataRootDir;
		await new Promise<void>((resolve) => {
			ctx.harper.process.once('exit', () => resolve());
			ctx.harper.process.kill('SIGKILL');
		});
		let torn = 0;
		for (const file of userTxnLogFiles(dataRootDir)) {
			torn = Math.max(torn, tearLastTransaction(file, READABLE_BEFORE_BREAK));
		}
		// Fail loudly, not vacuously, if the framing or the transaction grouping ever changes.
		ok(torn > READABLE_BEFORE_BREAK, `expected to tear a multi-entry transaction, tore ${torn} entries`);

		await startHarper(ctx);

		// None of it: the break makes the rest of that insert unreadable, so the readable prefix is
		// discarded rather than committed as a transaction the source never committed.
		equal(await countInRange(ctx.harper, 1001, TORN_IDS), 0, 'the truncated transaction must not be applied in part');
		// The transactions that completed ahead of the break are unaffected: fail-stop costs the
		// transaction the break landed in, not the log up to it.
		equal(await countInRange(ctx.harper, 1, EARLIER_IDS), EARLIER_IDS);
	});
});
