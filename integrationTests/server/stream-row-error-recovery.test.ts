/**
 * A read-snapshot expiry raised inside a row's own transform (a nested read that outlives its snapshot)
 * cuts the response off; a row's own failure stays an in-band item. The expiry arms need RocksDB.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { resolve } from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'stream-row-error-recovery');
const MAX_TXN_OPEN_MS = 400;
const isLMDB = (process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb').toLowerCase() === 'lmdb';

interface Capture {
	status: number | null;
	sawTerminalChunk: boolean;
	body: string;
}

function decodeBody(raw: Buffer): Capture {
	const headerEnd = raw.indexOf('\r\n\r\n');
	if (headerEnd === -1) return { status: null, sawTerminalChunk: false, body: '' };
	const head = raw.subarray(0, headerEnd).toString('latin1');
	const status = Number.parseInt(head.split(' ')[1], 10);
	const bodyRaw = raw.subarray(headerEnd + 4);
	if (!/^transfer-encoding:\s*chunked/im.test(head)) {
		return { status, sawTerminalChunk: true, body: bodyRaw.toString('utf8') };
	}
	const parts: Buffer[] = [];
	let offset = 0;
	let sawTerminalChunk = false;
	while (offset < bodyRaw.length) {
		const lineEnd = bodyRaw.indexOf('\r\n', offset);
		if (lineEnd === -1) break;
		const size = Number.parseInt(bodyRaw.subarray(offset, lineEnd).toString('latin1'), 16);
		if (!Number.isSafeInteger(size)) break;
		if (size === 0) {
			sawTerminalChunk = true;
			break;
		}
		const dataEnd = lineEnd + 2 + size;
		parts.push(bodyRaw.subarray(lineEnd + 2, Math.min(dataEnd, bodyRaw.length)));
		if (dataEnd > bodyRaw.length) break;
		offset = dataEnd + 2;
	}
	return { status, sawTerminalChunk, body: Buffer.concat(parts).toString('utf8') };
}

// A raw socket exposes whether the chunked terminator arrived, which fetch() hides behind its own error handling.
function request(
	baseURL: string,
	auth: string,
	accept: string,
	target: { path: string } | { post: object }
): Promise<Capture> {
	const url = new URL(baseURL);
	const payload = 'post' in target ? JSON.stringify(target.post) : '';
	const head =
		('post' in target ? 'POST / HTTP/1.1' : `GET ${target.path} HTTP/1.1`) +
		`\r\nHost: ${url.host}\r\nAccept: ${accept}\r\nAuthorization: ${auth}\r\nConnection: close\r\n` +
		('post' in target ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : '') +
		'\r\n';
	return new Promise((resolvePromise, reject) => {
		const chunks: Buffer[] = [];
		const socket = net.createConnection({ host: url.hostname, port: Number(url.port) }, () => {
			socket.write(head + payload);
		});
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`no response to ${accept} ${JSON.stringify(target)} within 20s`));
		}, 20_000);
		socket.on('data', (data: Buffer) => chunks.push(data));
		socket.on('error', () => {});
		socket.on('close', () => {
			clearTimeout(timer);
			resolvePromise(decodeBody(Buffer.concat(chunks)));
		});
	});
}

suite('a failing row in a streamed collection read', (ctx: ContextWithHarper) => {
	let auth = '';
	const GROUP_QUERY = '/Parent/?group=g&select(id,seq,flaky)';
	// limit(2) ends the scan right after the failing row, so the only failure the stream can see is the row's own
	const GATED_QUERY = '/Parent/?group=h&limit(2)&select(id,seq,gated,children{id,val})';
	const searchOperation = (attribute: string, value: string, getAttributes: string[], limit?: number) => ({
		operation: 'search_by_conditions',
		database: 'data',
		table: 'Parent',
		conditions: [{ search_attribute: attribute, search_type: 'equals', search_value: value }],
		get_attributes: getAttributes,
		...(limit && { limit }),
	});

	const rest = (accept: string, path: string) => request(ctx.harper.httpURL, auth, accept, { path });
	const operation = (accept: string, post: object) => request(ctx.harper.operationsAPIURL, auth, accept, { post });
	const probe = async (): Promise<{ threadId: number; observed: string[] }> => {
		const response = await fetch(`${ctx.harper.httpURL}/Probe/`, { headers: { Authorization: auth } });
		strictEqual(response.status, 200);
		return response.json();
	};
	const lines = (body: string) =>
		body
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS },
				threads: { count: 1 },
				logging: { level: 'warn' },
			},
			env: {},
		});
		auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const ready = await fetch(`${ctx.harper.httpURL}/Parent/?id=none`, { headers: { Authorization: auth } }).catch(
				() => null
			);
			if (ready?.status === 200) break;
			await sleep(250);
		}
		const insert = async (table: string, records: object[]) => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify({ operation: 'insert', database: 'data', table, records }),
			});
			strictEqual(response.status, 200, `seeding ${table} failed: ${await response.text()}`);
		};
		const parents = [];
		const children = [];
		for (const group of ['g', 'h']) {
			for (let seq = 1; seq <= 4; seq++) {
				const id = `${group}-${seq}`;
				parents.push({ id, group, seq });
				for (let child = 0; child < 30; child++)
					children.push({ id: `${id}-c${child}`, parentId: id, val: `child ${child} of ${id}` });
			}
		}
		await insert('Parent', parents);
		await insert('Child', children);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('control: a query with no failing row returns every row', async () => {
		const capture = await rest('application/json', '/Parent/?group=g&select(id,seq)');
		strictEqual(capture.status, 200);
		strictEqual(capture.sawTerminalChunk, true);
		deepStrictEqual(
			JSON.parse(capture.body).map((row: any) => row.id),
			['g-1', 'g-2', 'g-3', 'g-4']
		);
	});

	suite('a row-local error', () => {
		function assertRecovered(rows: any[]) {
			strictEqual(rows.length, 4);
			deepStrictEqual(rows[0], { id: 'g-1', seq: 1, flaky: 'ok-1' });
			strictEqual(rows[1].error, 'Error');
			ok(rows[1].message.includes('flaky failed at seq=2'), rows[1].message);
			strictEqual(rows[1].id, 'g-2', 'the failed row keeps its primary key');
			strictEqual(rows[2].id, 'g-3');
			strictEqual(rows[3].id, 'g-4');
		}

		test('REST: stays an in-band item with its primary key on a single-condition scan', async () => {
			const capture = await rest('application/json', GROUP_QUERY);
			strictEqual(capture.status, 200);
			strictEqual(capture.sawTerminalChunk, true);
			assertRecovered(JSON.parse(capture.body));
		});

		test('REST: stays an in-band item with its primary key on a multi-condition scan', async () => {
			const capture = await rest('application/json', '/Parent/?group=g&seq=ge=1&select(id,seq,flaky)');
			strictEqual(capture.sawTerminalChunk, true);
			assertRecovered(JSON.parse(capture.body));
		});

		test('operations API: stays an in-band item with its primary key', async () => {
			const capture = await operation('application/json', searchOperation('group', 'g', ['id', 'seq', 'flaky']));
			strictEqual(capture.status, 200);
			strictEqual(capture.sawTerminalChunk, true);
			assertRecovered(JSON.parse(capture.body));
		});

		for (const accept of ['application/x-ndjson', 'application/ndjson']) {
			test(`REST ${accept}: ends with the terminal record after the rows before it`, async () => {
				const capture = await rest(accept, GROUP_QUERY);
				const records = lines(capture.body);
				strictEqual(records.length, 2);
				deepStrictEqual(records[0], { id: 'g-1', seq: 1, flaky: 'ok-1' });
				ok(records[1].$harperStreamError.message.includes('flaky failed at seq=2'));
			});

			test(`operations API ${accept}: ends with the terminal record, not an in-band row`, async () => {
				const capture = await operation(accept, searchOperation('group', 'g', ['id', 'seq', 'flaky']));
				const records = lines(capture.body);
				strictEqual(records.length, 2, capture.body);
				deepStrictEqual(records[0], { id: 'g-1', seq: 1, flaky: 'ok-1' });
				ok(records[1].$harperStreamError.message.includes('flaky failed at seq=2'));
			});
		}
	});

	suite(
		'a read-snapshot expiry inside a row',
		{ skip: isLMDB ? 'an LMDB read transaction cannot expire' : false },
		() => {
			function assertCutOff(capture: Capture, rowsBefore: string) {
				strictEqual(capture.status, 200, 'the head was already sent');
				strictEqual(capture.sawTerminalChunk, false, 'the transfer is aborted, not completed');
				ok(capture.body.startsWith('[' + rowsBefore), capture.body.slice(0, 200));
				throws(() => JSON.parse(capture.body), SyntaxError);
				ok(!capture.body.trimEnd().endsWith(']'), 'the array is not closed');
			}

			test('REST JSON: the response is cut off instead of finishing as a complete array', async () => {
				const before = await probe();
				const capture = await rest('application/json', GATED_QUERY);
				assertCutOff(capture, '{"id":"h-1"');
				const after = await probe();
				ok(after.observed.length > before.observed.length, "the row's own transform received the expiry");
				strictEqual(after.observed[after.observed.length - 1], 'ReadSnapshotExpiredError');
			});

			test('operations API JSON: the response is cut off instead of finishing as a complete array', async () => {
				const capture = await operation('application/json', searchOperation('group', 'h', ['id', 'seq', 'gated'], 2));
				// Under Bun, Fastify answers 500 when the stream fails before its head reaches the client
				if (capture.status === 200) assertCutOff(capture, '{"id":"h-1"');
				else {
					strictEqual(capture.status, 500);
					ok(capture.body.includes('response destroyed before completion'), capture.body);
				}
			});

			test('REST CSV: the response is cut off and the worker survives', async () => {
				const before = await probe();
				const capture = await rest('text/csv', '/Parent/?group=h&limit(2)&select(id,seq,gated)');
				strictEqual(capture.sawTerminalChunk, false, 'the transfer is aborted, not completed or left hanging');
				const after = await probe();
				strictEqual(after.threadId, before.threadId);
				strictEqual(after.observed[after.observed.length - 1], 'ReadSnapshotExpiredError');
			});

			test('operations API application/x-ndjson: ends with its terminal record', async () => {
				const capture = await operation(
					'application/x-ndjson',
					searchOperation('group', 'h', ['id', 'seq', 'gated'], 2)
				);
				const records = lines(capture.body);
				strictEqual(records.length, 2, capture.body);
				strictEqual(records[1].$harperStreamError.error, 'ReadSnapshotExpiredError');
			});

			test('REST application/x-ndjson: ends with its terminal record', async () => {
				const capture = await rest('application/x-ndjson', '/Parent/?group=h&limit(2)&select(id,seq,gated)');
				const records = lines(capture.body);
				strictEqual(records.length, 2, capture.body);
				strictEqual(records[1].$harperStreamError.error, 'ReadSnapshotExpiredError');
			});
		}
	);
});
