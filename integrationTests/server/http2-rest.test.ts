/**
 * End-to-end HTTP/2 REST request-path regressions over direct TLS (`http.http2: true`) and the
 * per-worker cleartext h2c UDS mirror (`HARPER_H2C_UDS=1`): request bodies without `content-length`
 * (POST, PATCH, PUT, QUERY, custom Resource post()), bodyless GET/DELETE, and `GET /openapi`
 * emitting the real `:authority` host instead of `undefined`.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { connect, type ClientHttp2Session } from 'node:http2';
import { connect as netConnect } from 'node:net';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

// Bun uses Bun.serve() and uWS uses uWebSockets.js rather than Node's node:http2 server;
// Windows skips the component-deploy restart path (#549).
const skipSuite =
	process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun' || Boolean(process.env.HARPER_UWS_HTTP);

const REQUEST_TIMEOUT_MS = 10_000;

async function writeFixtureApp(parentDir: string): Promise<string> {
	await writeFile(
		join(parentDir, 'config.yaml'),
		['rest: true', 'graphqlSchema:', '  files: schema.graphql', 'jsResource:', '  files: resources.js', ''].join('\n')
	);
	await writeFile(
		join(parentDir, 'schema.graphql'),
		[
			'type H2Note @table @export {',
			'	id: ID @primaryKey',
			'	title: String @indexed',
			'	tag: String @indexed',
			'	rev: Int',
			'}',
			'',
		].join('\n')
	);
	await writeFile(
		join(parentDir, 'resources.js'),
		[
			'export class H2Custom extends Resource {',
			'	async post(data) {',
			'		return { received: data ?? null, hadData: data !== undefined };',
			'	}',
			'}',
			'',
		].join('\n')
	);
	return parentDir;
}

function h2Request(
	session: ClientHttp2Session,
	headers: Record<string, string>,
	{ body, endStream }: { body?: string; endStream?: boolean } = {}
): Promise<{ status: number; headers: Record<string, unknown>; text: string; json: () => any }> {
	return new Promise((resolve, reject) => {
		const options = endStream !== undefined ? { endStream } : undefined;
		const stream = session.request(headers, options);
		let responseHeaders: Record<string, unknown> = {};
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			stream.destroy(new Error(`HTTP/2 request timed out: ${headers[':method']} ${headers[':path']}`));
		}, REQUEST_TIMEOUT_MS);
		stream.on('response', (resHeaders) => {
			responseHeaders = resHeaders;
		});
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('end', () => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString('utf8');
			resolve({
				status: Number(responseHeaders[':status']),
				headers: responseHeaders,
				text,
				json: () => JSON.parse(text),
			});
		});
		stream.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		if (!endStream) {
			if (body !== undefined) stream.write(body);
			if (endStream === false || body !== undefined || ['POST', 'PUT', 'PATCH', 'QUERY'].includes(headers[':method'])) {
				stream.end();
			}
		}
	});
}

async function exerciseSession(session: ClientHttp2Session, auth: string, expectedOpenApiUrl: string, prefix: string) {
	const postRes = await h2Request(
		session,
		{
			':method': 'POST',
			':path': '/H2Note/',
			'authorization': auth,
			'content-type': 'application/json',
		},
		{ body: JSON.stringify({ id: `${prefix}-1`, title: 'first', tag: prefix, rev: 1 }) }
	);
	assert.strictEqual(postRes.status, 201, postRes.text);
	assert.strictEqual(postRes.json(), `${prefix}-1`);

	const patchRes = await h2Request(
		session,
		{
			':method': 'PATCH',
			':path': `/H2Note/${prefix}-1`,
			'authorization': auth,
			'content-type': 'application/json',
		},
		{ body: JSON.stringify({ title: 'patched', rev: 2 }) }
	);
	assert.strictEqual(patchRes.status, 204, patchRes.text);

	const afterPatch = await h2Request(session, {
		':method': 'GET',
		':path': `/H2Note/${prefix}-1`,
		'authorization': auth,
	});
	assert.strictEqual(afterPatch.status, 200, afterPatch.text);
	assert.strictEqual(afterPatch.json().title, 'patched');
	assert.strictEqual(afterPatch.json().tag, prefix);
	assert.strictEqual(afterPatch.json().rev, 2);

	const putRes = await h2Request(
		session,
		{
			':method': 'PUT',
			':path': `/H2Note/${prefix}-1`,
			'authorization': auth,
			'content-type': 'application/json',
		},
		{ body: JSON.stringify({ title: 'replaced', tag: prefix }) }
	);
	assert.strictEqual(putRes.status, 204, putRes.text);

	const afterPut = await h2Request(session, {
		':method': 'GET',
		':path': `/H2Note/${prefix}-1`,
		'authorization': auth,
	});
	assert.strictEqual(afterPut.status, 200, afterPut.text);
	assert.strictEqual(afterPut.json().title, 'replaced');
	assert.strictEqual(afterPut.json().rev, undefined);

	const queryRes = await h2Request(
		session,
		{
			':method': 'QUERY',
			':path': '/H2Note/',
			'authorization': auth,
			'content-type': 'application/json',
		},
		{
			body: JSON.stringify({
				conditions: [{ attribute: 'tag', comparator: 'equals', value: prefix }],
			}),
		}
	);
	assert.strictEqual(queryRes.status, 200, queryRes.text);
	const rows = queryRes.json();
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(rows[0].id, `${prefix}-1`);
	assert.strictEqual(rows[0].title, 'replaced');

	const customRes = await h2Request(
		session,
		{
			':method': 'POST',
			':path': '/H2Custom/',
			'authorization': auth,
			'content-type': 'application/json',
		},
		{ body: JSON.stringify({ key: prefix, ok: true }) }
	);
	assert.strictEqual(customRes.status, 200, customRes.text);
	assert.deepStrictEqual(customRes.json(), { received: { key: prefix, ok: true }, hadData: true });

	const etag = String(afterPut.headers.etag ?? '');
	assert.ok(etag, 'expected ETag on GET response');

	const stalePatch = await h2Request(
		session,
		{
			':method': 'PATCH',
			':path': `/H2Note/${prefix}-1`,
			'authorization': auth,
			'content-type': 'application/json',
			'if-match': '"stale"',
		},
		{ body: JSON.stringify({ title: 'rejected' }) }
	);
	assert.strictEqual(stalePatch.status, 412, stalePatch.text);

	const staleDel = await h2Request(session, {
		':method': 'DELETE',
		':path': `/H2Note/${prefix}-1`,
		'authorization': auth,
		'if-match': '"stale"',
	});
	assert.strictEqual(staleDel.status, 412, staleDel.text);

	const delRes = await h2Request(session, {
		':method': 'DELETE',
		':path': `/H2Note/${prefix}-1`,
		'authorization': auth,
		'if-match': etag,
	});
	assert.strictEqual(delRes.status, 200, delRes.text);

	const afterDelete = await h2Request(session, {
		':method': 'GET',
		':path': `/H2Note/${prefix}-1`,
		'authorization': auth,
	});
	assert.strictEqual(afterDelete.status, 404, afterDelete.text);

	const openApiRes = await h2Request(session, {
		':method': 'GET',
		':path': '/openapi',
		'authorization': auth,
	});
	assert.strictEqual(openApiRes.status, 200, openApiRes.text);
	assert.strictEqual(openApiRes.json().servers[0].url, expectedOpenApiUrl);
}

suite(
	'HTTP/2 REST bodies without content-length and OpenAPI hostname',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let fixtureDir: string;
		let auth: string;

		before(async () => {
			fixtureDir = await mkdtemp(join(tmpdir(), 'harper-h2-rest-'));
			await writeFixtureApp(fixtureDir);
			await setupHarperWithFixture(ctx, fixtureDir, {
				config: { http: { http2: true }, tls: { unixDomainSockets: true }, threads: { count: 1 } },
				env: { HARPER_H2C_UDS: '1' },
			});
			auth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		});

		after(async () => {
			try {
				await teardownHarper(ctx);
			} finally {
				if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
			}
		});

		test('handles REST writes, QUERY, custom Resource, bodyless ops, and /openapi over direct TLS HTTP/2', async () => {
			const authority = `${ctx.harper.hostname}:9927`;
			const session = connect(`https://${authority}`, { rejectUnauthorized: false });
			try {
				await exerciseSession(session, auth, `https://${authority}`, 'tls');
			} finally {
				session.close();
			}
		});

		test('handles REST writes, QUERY, custom Resource, bodyless ops, and /openapi over HARPER_H2C_UDS', async () => {
			const socketsDir = join(ctx.harper.dataRootDir, 'sockets');
			const entries = await readdir(socketsDir);
			const h2Socket =
				entries.find((name) => name.endsWith('-9927-h2.sock')) ?? entries.find((name) => name.endsWith('-h2.sock'));
			assert.ok(h2Socket, `expected an *-9927-h2.sock mirror in ${socketsDir}, found: ${entries.join(', ')}`);
			const socketPath = join(socketsDir, h2Socket);
			const authority = 'h2c-uds.internal:9927';
			const session = connect(`http://${authority}`, {
				createConnection: () => netConnect(socketPath),
			});
			try {
				await exerciseSession(session, auth, `http://${authority}`, 'uds');
			} finally {
				session.close();
			}
		});
	}
);
