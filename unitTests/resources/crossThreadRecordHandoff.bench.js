/**
 * Ways a thread could get a committed record's value without decoding it: what each costs the receiving thread
 * per record, against decoding it, at three record sizes. A manual run, not part of CI:
 *
 *   npm run build && npx mocha unitTests/resources/crossThreadRecordHandoff.bench.js
 *
 * In-thread, ns per record:
 * - decode: RecordEncoder.decode of the stored bytes plus the record-object promotion getEntry does
 * - cloneSerialize / cloneDeserialize: v8.serialize of the decoded record (once per receiving port) and
 *   v8.deserialize (each receiver), what postMessage of a value pays
 * - jsonEncode: serializeMessage (the MQTT default, JSON) to a Buffer, which each thread with an MQTT subscriber
 *   to the record pays once
 *
 * Across a real worker thread (receiver CPU per record, from process.threadCpuUsage in the worker; sender CPU
 * per record), with CROSS_THREAD_BENCH_BATCH records per message (default 1, then 64):
 * - value: postMessage of the decoded record (structured clone)
 * - bytes: postMessage of the stored record bytes (copied), which the receiver would still have to decode
 * - shared: the JSON payload written once into a SharedArrayBuffer; the message carries offsets, and the
 *   receiver takes a Buffer view of each, ready for a PUBLISH frame
 *
 * CROSS_THREAD_BENCH_ROUNDS (default 5) rounds alternate the order. CROSS_THREAD_BENCH_OUT appends JSON lines.
 */
const assert = require('node:assert');
const { appendFileSync } = require('node:fs');
const v8 = require('node:v8');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { serializeMessage } = require('#src/server/serverHelpers/contentTypes');
require('#src/server/serverHelpers/serverUtilities');

const RECORDS = Number(process.env.CROSS_THREAD_BENCH_RECORDS ?? 2000);
const ROUNDS = Number(process.env.CROSS_THREAD_BENCH_ROUNDS ?? 5);
const REPEATS = Number(process.env.CROSS_THREAD_BENCH_REPEATS ?? 10);
const BATCHES = (process.env.CROSS_THREAD_BENCH_BATCH ?? '1,64').split(',').map(Number);
const OUT = process.env.CROSS_THREAD_BENCH_OUT;
const SIZES = { '100B': 3, '1KB': 47, '10KB': 491 };

function makeRecord(seq, readings) {
	return {
		seq,
		device: `device-${seq % 100}`,
		active: seq % 2 === 0,
		temperature: 20 + (seq % 50) / 10,
		readings: Array.from({ length: readings }, (_, i) => ({
			t: 1_700_000_000_000 + seq * 1000 + i,
			v: ((seq * 31 + i) % 1000) / 10,
			unit: i % 3 ? 'C' : 'F',
		})),
	};
}

const cpuMicros = (since) => {
	const usage = process.threadCpuUsage(since);
	return usage.user + usage.system;
};
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// The receiver: counts what arrives and reports its own CPU between a start and a stop message.
const RECEIVER = `
const { parentPort } = require('node:worker_threads');
let start, received = 0, touched = 0, sab;
const take = (item) => {
	received++;
	touched += item instanceof Uint8Array ? item.length : item.seq;
};
parentPort.on('message', (message) => {
	switch (message.cmd) {
		case 'sab': sab = message.sab; return;
		case 'start': received = 0; start = process.threadCpuUsage(); return;
		case 'stop': {
			const usage = process.threadCpuUsage(start);
			parentPort.postMessage({ cpu: usage.user + usage.system, received, touched });
			return;
		}
		case 'value': for (const item of message.items) take(item); return;
		case 'bytes': for (const item of message.items) take(item); return;
		case 'shared': {
			const offsets = message.offsets;
			for (let i = 0; i < offsets.length; i += 2) {
				const payload = Buffer.from(sab, offsets[i], offsets[i + 1]);
				touched += payload.length;
				received++;
			}
			return;
		}
	}
});
`;

describe('cross-thread hand-off of a committed record vs decoding it (bench)', function () {
	this.timeout(0);
	let worker;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		worker = new Worker(RECEIVER, { eval: true });
	});
	after(() => worker?.terminate());

	it('measures decode, structured clone, JSON encode and worker transport per record', async () => {
		const reply = () => new Promise((resolve) => worker.once('message', resolve));
		const results = [];
		const record = (row) => {
			results.push(row);
			if (OUT) appendFileSync(OUT, JSON.stringify(row) + '\n');
		};
		const ids = Array.from({ length: RECORDS }, (_, i) => `rec-${String(i).padStart(5, '0')}`);
		const fixtures = {};
		let seq = 0;
		for (const [label, readings] of Object.entries(SIZES)) {
			const T = table({
				database: 'handoffbench',
				table: `Handoff${label}`,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'seq' },
					{ name: 'device' },
					{ name: 'active' },
					{ name: 'temperature' },
					{ name: 'readings' },
				],
			});
			for (const id of ids) await T.put(id, makeRecord(seq++, readings));
			const store = T.primaryStore;
			const stored = ids.map((id) => Buffer.from(store.getBinarySync(id)));
			const values = ids.map((id) => store.getEntry(id, { uncachedRead: true }).value);
			const json = values.map((value) => Buffer.from(serializeMessage(value)));
			const cloned = values.map((value) => v8.serialize(value));
			// one shared region holding every record's JSON payload, as a cross-thread payload ring would
			const sab = new SharedArrayBuffer(json.reduce((sum, b) => sum + b.length, 0));
			const sabView = new Uint8Array(sab);
			const offsets = [];
			let at = 0;
			for (const payload of json) {
				offsets.push(at, payload.length);
				at += payload.length;
			}
			fixtures[label] = { store, stored, values, json, cloned, sab, sabView, offsets };
			const sample = values[0];
			assert.strictEqual(v8.deserialize(cloned[0]).seq, sample.seq, 'a clone carries the stored fields');
			assert.deepStrictEqual(JSON.parse(json[0]), JSON.parse(JSON.stringify(sample)));
		}

		const perRecord = (fn) => {
			for (let i = 0; i < RECORDS; i++) fn(i); // warm
			const start = process.threadCpuUsage();
			for (let r = 0; r < REPEATS; r++) for (let i = 0; i < RECORDS; i++) fn(i);
			return Math.round((cpuMicros(start) * 1000) / (REPEATS * RECORDS));
		};
		const inThread = (label) => {
			const { store, stored, values, cloned } = fixtures[label];
			const enc = store.decoder;
			const promote = (value) => {
				const promoted = new enc.structPrototype.constructor();
				for (const key of Object.keys(value)) promoted[key] = value[key];
				return promoted;
			};
			return {
				decode: perRecord((i) => promote(enc.decode(stored[i]).value)),
				cloneSerialize: perRecord((i) => v8.serialize(values[i])),
				cloneDeserialize: perRecord((i) => v8.deserialize(cloned[i])),
				jsonEncode: perRecord((i) => Buffer.from(serializeMessage(values[i]))),
			};
		};

		const transport = async (label, mode, batch) => {
			const { stored, values, sab, sabView, json, offsets } = fixtures[label];
			if (mode === 'shared') {
				worker.postMessage({ cmd: 'sab', sab });
			}
			worker.postMessage({ cmd: 'start' });
			const start = process.threadCpuUsage();
			for (let r = 0; r < REPEATS; r++) {
				for (let i = 0; i < RECORDS; i += batch) {
					const end = Math.min(i + batch, RECORDS);
					if (mode === 'value') worker.postMessage({ cmd: 'value', items: values.slice(i, end) });
					else if (mode === 'bytes') worker.postMessage({ cmd: 'bytes', items: stored.slice(i, end) });
					else {
						// the producer copies each payload into the shared region; the message names where
						for (let j = i; j < end; j++) sabView.set(json[j], offsets[2 * j]);
						worker.postMessage({ cmd: 'shared', offsets: offsets.slice(2 * i, 2 * end) });
					}
				}
			}
			const senderNs = Math.round((cpuMicros(start) * 1000) / (REPEATS * RECORDS));
			const done = reply();
			worker.postMessage({ cmd: 'stop' });
			const { cpu, received } = await done;
			assert.strictEqual(received, REPEATS * RECORDS, `${mode} delivered every record`);
			return { senderNs, receiverNs: Math.round((cpu * 1000) / (REPEATS * RECORDS)) };
		};

		const labels = Object.keys(SIZES);
		const modes = ['value', 'bytes', 'shared'];
		for (let round = 0; round < ROUNDS; round++) {
			for (const label of round % 2 ? [...labels].reverse() : labels) {
				global.gc?.();
				record({ kind: 'inThread', round, size: label, ...inThread(label) });
				for (const batch of BATCHES) {
					for (const mode of round % 2 ? [...modes].reverse() : modes) {
						global.gc?.();
						record({ kind: 'transport', round, size: label, mode, batch, ...(await transport(label, mode, batch)) });
					}
				}
			}
		}

		const summarize = (rows, field) => {
			const values = rows.map((row) => row[field]);
			return `${median(values)} (${Math.min(...values)}–${Math.max(...values)})`;
		};
		const inThreadTable = labels.map((label) => {
			const rows = results.filter((row) => row.kind === 'inThread' && row.size === label);
			const recordBytes = Math.round(fixtures[label].stored.reduce((sum, b) => sum + b.length, 0) / RECORDS);
			const jsonBytes = Math.round(fixtures[label].json.reduce((sum, b) => sum + b.length, 0) / RECORDS);
			return {
				size: label,
				recordBytes,
				jsonBytes,
				decode: summarize(rows, 'decode'),
				cloneSerialize: summarize(rows, 'cloneSerialize'),
				cloneDeserialize: summarize(rows, 'cloneDeserialize'),
				jsonEncode: summarize(rows, 'jsonEncode'),
			};
		});
		const transportTable = [];
		for (const label of labels) {
			for (const batch of BATCHES) {
				for (const mode of modes) {
					const rows = results.filter(
						(row) => row.kind === 'transport' && row.size === label && row.mode === mode && row.batch === batch
					);
					transportTable.push({
						size: label,
						batch,
						mode,
						senderNs: summarize(rows, 'senderNs'),
						receiverNs: summarize(rows, 'receiverNs'),
					});
				}
			}
		}
		console.log(`\nIn-thread CPU ns per record, median (min–max) of ${ROUNDS} rounds`);
		console.table(inThreadTable);
		console.log(`\nWorker transport CPU ns per record, median (min–max) of ${ROUNDS} rounds`);
		console.table(transportTable);
	});
});
