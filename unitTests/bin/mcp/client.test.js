const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { runBridge, resolveConnection } = require('#src/bin/mcp/client');

class ChunkSink extends Writable {
	constructor() {
		super();
		this.chunks = [];
	}
	_write(chunk, _enc, cb) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
		cb();
	}
	get text() {
		return this.chunks.join('');
	}
}

function stdinFromLines(lines) {
	const s = new Readable({ read() {} });
	for (const l of lines) s.push(l + '\n');
	s.push(null);
	return s;
}

function startFakeServer(handler) {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			resolve({ server, port: addr.port });
		});
	});
}

describe('bin/mcp/client.runBridge', () => {
	let fake;
	afterEach(() => {
		fake?.server.close();
	});

	it('POSTs each stdin frame and writes the JSON response to stdout', async () => {
		const recvRequests = [];
		fake = await startFakeServer((req, res) => {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				recvRequests.push({ method: req.method, headers: req.headers, body });
				if (req.method === 'GET') {
					// Held-open SSE channel — keep alive briefly then end.
					res.writeHead(200, { 'content-type': 'text/event-stream' });
					setTimeout(() => res.end(), 10);
					return;
				}
				const parsed = JSON.parse(body);
				const isInit = parsed.method === 'initialize';
				res.writeHead(200, {
					'content-type': 'application/json',
					...(isInit ? { 'mcp-session-id': 'sid-1' } : {}),
				});
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: parsed.id,
						result: isInit ? { protocolVersion: '2025-06-18' } : { tools: [] },
					})
				);
			});
		});

		const stdin = stdinFromLines([
			JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
			JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
		]);
		const stdout = new ChunkSink();
		const stderr = new ChunkSink();

		await runBridge({
			connection: { protocol: 'http:', hostname: '127.0.0.1', port: fake.port, rejectUnauthorized: false },
			mountPath: '/mcp',
			stdin,
			stdout,
			stderr,
		});

		const lines = stdout.text.split('\n').filter(Boolean);
		assert.equal(lines.length, 2, 'two responses written to stdout');
		const r1 = JSON.parse(lines[0]);
		const r2 = JSON.parse(lines[1]);
		assert.equal(r1.id, 1);
		assert.equal(r1.result.protocolVersion, '2025-06-18');
		assert.equal(r2.id, 2);
		assert.deepEqual(r2.result.tools, []);

		// Second POST should carry the captured session id.
		const posts = recvRequests.filter((r) => r.method === 'POST');
		assert.equal(posts[1].headers['mcp-session-id'], 'sid-1');
	});

	it('parses an SSE response and emits each message frame to stdout', async () => {
		fake = await startFakeServer((req, res) => {
			if (req.method === 'GET') {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				setTimeout(() => res.end(), 10);
				return;
			}
			res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sid-2' });
			res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n\n');
			res.end();
		});
		const stdin = stdinFromLines([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })]);
		const stdout = new ChunkSink();
		const stderr = new ChunkSink();
		await runBridge({
			connection: { protocol: 'http:', hostname: '127.0.0.1', port: fake.port, rejectUnauthorized: false },
			mountPath: '/mcp',
			stdin,
			stdout,
			stderr,
		});
		const frame = JSON.parse(stdout.text.split('\n').filter(Boolean)[0]);
		assert.equal(frame.result.ok, true);
	});

	it('returns a JSON-RPC error frame when the POST fails outright', async () => {
		// No fake server bound — connection refused.
		const stdin = stdinFromLines([JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'initialize' })]);
		const stdout = new ChunkSink();
		const stderr = new ChunkSink();
		await runBridge({
			connection: { protocol: 'http:', hostname: '127.0.0.1', port: 1, rejectUnauthorized: false },
			mountPath: '/mcp',
			stdin,
			stdout,
			stderr,
		});
		const frame = JSON.parse(stdout.text.split('\n').filter(Boolean)[0]);
		assert.equal(frame.id, 42);
		assert.equal(frame.error.code, -32603);
		assert.ok(stderr.text.includes('POST failed'));
	});

	it('skips blank lines and logs (but does not crash on) malformed JSON', async () => {
		fake = await startFakeServer((req, res) => {
			if (req.method === 'GET') {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				setTimeout(() => res.end(), 10);
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sid' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
		});
		const stdin = stdinFromLines([
			'',
			'   ',
			'not json',
			JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		]);
		const stdout = new ChunkSink();
		const stderr = new ChunkSink();
		await runBridge({
			connection: { protocol: 'http:', hostname: '127.0.0.1', port: fake.port, rejectUnauthorized: false },
			mountPath: '/mcp',
			stdin,
			stdout,
			stderr,
		});
		const lines = stdout.text.split('\n').filter(Boolean);
		assert.equal(lines.length, 1, 'only the valid request produced a response');
		assert.ok(stderr.text.includes('not valid JSON'));
	});
});

describe('bin/mcp/client.resolveConnection', () => {
	it('throws a helpful error when --profile application is selected without --target', () => {
		assert.throws(
			() =>
				resolveConnection({
					subcommand: 'bridge',
					profile: 'application',
					mountPath: '/mcp',
					rejectUnauthorized: true,
					help: false,
				}),
			/application MCP endpoint is mounted on the application HTTP server/
		);
	});

	it('honors --target https://... in network mode regardless of profile', () => {
		const conn = resolveConnection({
			subcommand: 'bridge',
			profile: 'application',
			mountPath: '/mcp',
			target: 'https://node:9926',
			rejectUnauthorized: true,
			help: false,
		});
		assert.equal(conn.protocol, 'https:');
		assert.equal(conn.hostname, 'node');
		assert.equal(conn.port, '9926');
		assert.equal(conn.socketPath, undefined);
	});

	it('builds a Basic auth header from --username + --password', () => {
		const conn = resolveConnection({
			subcommand: 'bridge',
			profile: 'application',
			mountPath: '/mcp',
			target: 'https://node:9926',
			username: 'alice',
			password: 'pw',
			rejectUnauthorized: true,
			help: false,
		});
		const expected = `Basic ${Buffer.from('alice:pw').toString('base64')}`;
		assert.equal(conn.authHeader, expected);
	});

	it('--bearer wins over --username + --password', () => {
		const conn = resolveConnection({
			subcommand: 'bridge',
			profile: 'application',
			mountPath: '/mcp',
			target: 'https://node:9926',
			username: 'alice',
			password: 'pw',
			bearer: 'token-xyz',
			rejectUnauthorized: true,
			help: false,
		});
		assert.equal(conn.authHeader, 'Bearer token-xyz');
	});
});
