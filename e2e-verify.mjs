// Local e2e verification for the LangChain.js /v1 gateway leg (#631).
// Mimics @harperfast/integration-testing's spawn on 127.0.0.1 with high ports
// so it can run alongside a developer Harper on 9925/9926. Not committed.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const WORKTREE = new URL('.', import.meta.url).pathname;
const HTTP = 'http://127.0.0.1:21926';
const ROOT = process.env.E2E_ROOT ?? mkdtempSync(join(tmpdir(), 'harper-e2e-verify-'));
console.log('root:', ROOT);
const ECHO = join(WORKTREE, 'integrationTests/server/fixtures/v1-gateway-test-backend.cjs');

const config = {
	modelsGateway: { enabled: true },
	models: {
		generative: { default: { backend: ECHO } },
		embedding: { default: { backend: ECHO } },
	},
};

const child = spawn(
	process.execPath,
	[
		join(WORKTREE, 'dist/bin/harper.js'),
		`--ROOTPATH=${ROOT}`,
		'--AUTHENTICATION_AUTHORIZELOCAL=true',
		'--HDB_ADMIN_USERNAME=admin',
		'--HDB_ADMIN_PASSWORD=password',
		'--THREADS_COUNT=1',
		'--THREADS_DEBUG=false',
		'--NODE_HOSTNAME=127.0.0.1',
		'--HTTP_PORT=127.0.0.1:21926',
		'--OPERATIONSAPI_NETWORK_PORT=127.0.0.1:21925',
		'--MQTT_NETWORK_PORT=127.0.0.1:21883',
		'--MQTT_NETWORK_SECUREPORT=127.0.0.1:21884',
		'--LOGGING_LEVEL=warn',
		'--LOGGING_STDSTREAMS=true',
	],
	{
		env: process.env.E2E_SKIP_SETCONFIG
			? { ...process.env, HOME: ROOT, USERPROFILE: ROOT }
			: { ...process.env, HARPER_SET_CONFIG: JSON.stringify(config), HOME: ROOT, USERPROFILE: ROOT },
		detached: true,
	}
);

let started = false;
const startupLog = [];
child.stdout.on('data', (d) => {
	const s = d.toString();
	startupLog.push(s);
	if (s.includes('successfully started')) started = true;
});
child.stderr.on('data', (d) => startupLog.push(d.toString()));
child.on('exit', (code) => {
	if (!started) {
		console.error('harper exited before startup, code', code);
		console.error(startupLog.join(''));
		process.exit(1);
	}
});

const deadline = Date.now() + 120_000;
while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
if (!started) {
	console.error('startup timed out\n', startupLog.join(''));
	process.kill(-child.pid, 'SIGKILL');
	process.exit(1);
}
console.log('harper started');

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}`);
		console.log(err);
	}
}

const basic = 'Basic ' + Buffer.from('admin:password').toString('base64');

const tokenRes = await fetch('http://127.0.0.1:21925', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Authorization: basic },
	body: JSON.stringify({ operation: 'create_authentication_tokens', username: 'admin', password: 'password' }),
});
const { operation_token: apiKey } = await tokenRes.json();
console.log('token minted:', !!apiKey);

await check('raw fetch: GET /v1/models', async () => {
	const res = await fetch(`${HTTP}/v1/models`, { headers: { Authorization: basic } });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.ok(body.data.some((m) => m.id === 'default'));
});

await check('raw fetch: embeddings encoding_format base64 round-trips', async () => {
	const res = await fetch(`${HTTP}/v1/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: basic },
		body: JSON.stringify({ model: 'default', input: 'hello world', encoding_format: 'base64' }),
	});
	assert.equal(res.status, 200, await res.clone().text());
	const body = await res.json();
	assert.equal(typeof body.data[0].embedding, 'string');
	const buf = Buffer.from(body.data[0].embedding, 'base64');
	const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	assert.ok(Math.abs(floats[0] - 0.1) < 1e-6, `got ${floats[0]}`);
});

await check('raw fetch: unknown encoding_format rejected 400', async () => {
	const res = await fetch(`${HTTP}/v1/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: basic },
		body: JSON.stringify({ model: 'default', input: 'x', encoding_format: 'int8' }),
	});
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error.type, 'invalid_request_error');
});

await check('OpenAI SDK: streaming chat', async () => {
	const { OpenAI } = await import('openai');
	const client = new OpenAI({ apiKey, baseURL: `${HTTP}/v1` });
	const stream = client.chat.completions.stream({
		model: 'default',
		messages: [{ role: 'user', content: 'tell me something' }],
	});
	const chunks = [];
	for await (const chunk of stream) {
		const delta = chunk.choices[0]?.delta?.content;
		if (delta) chunks.push(delta);
	}
	assert.ok(chunks.join('').includes('[echo stream]'));
	const completion = await stream.finalChatCompletion();
	assert.equal(completion.choices[0].finish_reason, 'stop');
});

await check('OpenAI SDK: embeddings (default base64 path)', async () => {
	const { OpenAI } = await import('openai');
	const client = new OpenAI({ apiKey, baseURL: `${HTTP}/v1` });
	const res = await client.embeddings.create({ model: 'default', input: 'hello world' });
	const vec = res.data[0].embedding;
	assert.ok(Array.isArray(vec) && vec.length === 4, `len ${vec.length}`);
	assert.ok(Math.abs(vec[0] - 0.1) < 1e-6, `got ${vec[0]}`);
});

await check('LangChain.js: ChatOpenAI invoke', async () => {
	const { ChatOpenAI } = await import('@langchain/openai');
	const chat = new ChatOpenAI({
		model: 'default',
		apiKey,
		configuration: { baseURL: `${HTTP}/v1` },
	});
	const res = await chat.invoke([{ role: 'user', content: 'hello from langchain' }]);
	assert.ok(typeof res.content === 'string' && res.content.includes('[echo]'), String(res.content));
	assert.ok(res.usage_metadata && res.usage_metadata.total_tokens > 0);
});

await check('LangChain.js: ChatOpenAI stream', async () => {
	const { ChatOpenAI } = await import('@langchain/openai');
	const chat = new ChatOpenAI({
		model: 'default',
		apiKey,
		configuration: { baseURL: `${HTTP}/v1` },
	});
	const chunks = [];
	const stream = await chat.stream('tell me something');
	for await (const chunk of stream) {
		if (typeof chunk.content === 'string' && chunk.content) chunks.push(chunk.content);
	}
	assert.ok(chunks.length > 1, `chunks: ${chunks.length}`);
	assert.ok(chunks.join('').includes('[echo stream]'));
});

await check('LangChain.js: OpenAIEmbeddings embedQuery + embedDocuments', async () => {
	const { OpenAIEmbeddings } = await import('@langchain/openai');
	const embeddings = new OpenAIEmbeddings({
		model: 'default',
		apiKey,
		configuration: { baseURL: `${HTTP}/v1` },
	});
	const vec = await embeddings.embedQuery('hello world');
	assert.ok(Array.isArray(vec) && vec.length === 4, `len ${vec.length}`);
	assert.ok(
		vec.every((n) => typeof n === 'number' && Number.isFinite(n)),
		String(vec)
	);
	assert.ok(Math.abs(vec[0] - 0.1) < 1e-6, `corrupted embedding: ${vec}`);
	const batch = await embeddings.embedDocuments(['foo', 'bar', 'baz']);
	assert.equal(batch.length, 3);
});

process.kill(-child.pid, 'SIGTERM');
setTimeout(() => {
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {}
	process.exit(failures ? 1 : 0);
}, 3000);
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
