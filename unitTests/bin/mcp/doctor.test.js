const assert = require('node:assert/strict');
const http = require('node:http');
const { runDoctor } = require('#src/bin/mcp/doctor');

function startFakeServer(handler) {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
	});
}

function readBody(req) {
	return new Promise((resolve) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => resolve(body));
	});
}

const BASE = {
	subcommand: 'doctor',
	profile: 'application',
	mountPath: '/mcp',
	rejectUnauthorized: false,
	help: false,
};

describe('bin/mcp/doctor.runDoctor', () => {
	let fake;
	afterEach(() => fake?.server.close());

	it('reports OK on all steps for a well-behaved Harper instance', async () => {
		fake = await startFakeServer(async (req, res) => {
			const body = await readBody(req);
			if (req.method === 'POST') {
				const parsed = JSON.parse(body);
				if (parsed.method === 'initialize') {
					res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sid-3' });
					res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-06-18' } }));
					return;
				}
				if (parsed.method === 'tools/list') {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'x' }] } }));
					return;
				}
			}
			if (req.method === 'DELETE') {
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(404);
			res.end();
		});
		const result = await runDoctor({ ...BASE, target: `http://127.0.0.1:${fake.port}` });
		assert.equal(result.ok, true);
		assert.equal(result.steps.length, 3);
		assert.deepEqual(
			result.steps.map((s) => s.name),
			['initialize', 'tools/list', 'session cleanup']
		);
		const ttl = result.steps.find((s) => s.name === 'tools/list');
		assert.match(ttl.detail, /1 tool\(s\) visible/);
	});

	it('reports FAIL when initialize HTTP-errors', async () => {
		fake = await startFakeServer((req, res) => {
			res.writeHead(500, { 'content-type': 'text/plain' });
			res.end('boom');
		});
		const result = await runDoctor({ ...BASE, target: `http://127.0.0.1:${fake.port}` });
		assert.equal(result.ok, false);
		assert.equal(result.steps[0].ok, false);
		assert.match(result.steps[0].detail, /HTTP 500/);
	});

	it('reports FAIL when initialize returns a JSON-RPC error', async () => {
		fake = await startFakeServer(async (req, res) => {
			const body = await readBody(req);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, error: { code: -32600, message: 'nope' } }));
		});
		const result = await runDoctor({ ...BASE, target: `http://127.0.0.1:${fake.port}` });
		assert.equal(result.ok, false);
		assert.match(result.steps[0].detail, /JSON-RPC error: nope/);
	});

	it('tolerates session-cleanup failure (still reports overall OK)', async () => {
		fake = await startFakeServer(async (req, res) => {
			const body = await readBody(req);
			if (req.method === 'POST') {
				const parsed = JSON.parse(body);
				res.writeHead(200, {
					'content-type': 'application/json',
					...(parsed.method === 'initialize' ? { 'mcp-session-id': 'sid-4' } : {}),
				});
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: parsed.id,
						result: parsed.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [] },
					})
				);
				return;
			}
			// DELETE returns 405 — allowClientDelete disabled.
			res.writeHead(405);
			res.end();
		});
		const result = await runDoctor({ ...BASE, target: `http://127.0.0.1:${fake.port}` });
		// initialize + tools/list pass; cleanup fails but doesn't tank overall OK.
		assert.equal(result.ok, true);
		assert.equal(result.steps.find((s) => s.name === 'session cleanup').ok, false);
	});
});
