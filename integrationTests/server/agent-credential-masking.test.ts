/**
 * The built-in agent's read-only reads keep credential values out of the model and the stored session
 * (#3097): a model `apiKey` that HARPER_SET_CONFIG writes into the config file, and a credential a log line
 * holds, read through `read_file`, `grep_files`, `tail_file` and `read_log`.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const CONFIG_SECRET = 'sk-config-3097-sentinel';
const LOGGED_SECRET = 'sk-logged-3097-sentinel';

const TOOL_CALLS = [
	{ name: 'read_file', arguments: { root: 'config' } },
	{ name: 'grep_files', arguments: { root: 'config', pattern: 'apiKey' } },
	{ name: 'tail_file', arguments: { root: 'logs', path: 'hdb.log', lines: 50 } },
	{ name: 'read_log', arguments: { limit: 50, order: 'desc' } },
	{ name: 'grep_files', arguments: { root: 'logs', pattern: 'logged-3097' } },
];

interface FakeModel {
	baseUrl: string;
	requests: string[];
	close: () => Promise<void>;
}

/** An OpenAI-compatible model that makes the tool calls above in order, one per turn, then answers. */
async function startFakeModel(): Promise<FakeModel> {
	const requests: string[] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			requests.push(raw);
			const { messages } = JSON.parse(raw) as { messages: { role: string }[] };
			const call = TOOL_CALLS[messages.filter((message) => message.role === 'tool').length];
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					choices: [
						{
							finish_reason: call ? 'tool_calls' : 'stop',
							message: call
								? {
										role: 'assistant',
										content: null,
										tool_calls: [
											{
												id: `call-${requests.length}`,
												type: 'function',
												function: { name: call.name, arguments: JSON.stringify(call.arguments) },
											},
										],
									}
								: { role: 'assistant', content: 'done' },
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

suite('agent credential masking (#3097)', (ctx: any) => {
	let fake: FakeModel;
	let client: any;

	const op = async (body: object) => {
		const response = await client.req().send(body);
		strictEqual(response.status, 200, response.text);
		return response.body;
	};

	before(async () => {
		fake = await startFakeModel();
		await startHarper(ctx, {
			config: {
				models: {
					generative: {
						default: { backend: 'openai', baseUrl: fake.baseUrl, apiKey: CONFIG_SECRET, model: 'fake-model' },
					},
				},
				agent: { enabled: true },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await fake.close();
		}
	});

	test('config and log reads reach the model and the stored session masked', async () => {
		const configuration = await op({ operation: 'get_configuration' });
		const configFile = await readFile(join(configuration.rootPath, 'harper-config.yaml'), 'utf8');
		ok(configFile.includes(CONFIG_SECRET), 'HARPER_SET_CONFIG writes the key into the config file');
		await appendFile(
			join(configuration.logging.root, 'hdb.log'),
			`${new Date().toISOString()} [main/0] [warn]: upstream call failed {"apiKey":"${LOGGED_SECRET}"}\n`
		);

		const { session_id: sessionId } = await op({ operation: 'agent_prompt', message: 'inspect config and logs' });
		const deadline = Date.now() + 30_000;
		let session: any;
		for (;;) {
			session = await op({ operation: 'get_agent_session', session_id: sessionId });
			if (session.status !== 'running' && session.status !== 'idle') break;
			ok(Date.now() < deadline, `session ${sessionId} still ${session.status} after 30s`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		strictEqual(session.status, 'completed', session.lastError);

		const results = session.messages.filter((message: any) => message.role === 'tool').map((m: any) => m.content);
		strictEqual(results.length, TOOL_CALLS.length);
		const [readConfig, grepConfig, tailLog, readLog, grepLogs] = results;
		ok(readConfig.includes(`apiKey: ${'*'.repeat(CONFIG_SECRET.length)}`), readConfig);
		ok(grepConfig.includes(`apiKey: ${'*'.repeat(CONFIG_SECRET.length)}`), grepConfig);
		const maskedLogged = `\\"apiKey\\":\\"${'*'.repeat(LOGGED_SECRET.length)}\\"`;
		ok(tailLog.includes(maskedLogged), tailLog);
		ok(readLog.includes(maskedLogged), readLog);
		ok(grepLogs.includes('"count":0'), grepLogs);

		for (const secret of [CONFIG_SECRET, LOGGED_SECRET]) {
			ok(!JSON.stringify(session).includes(secret), `the stored session holds ${secret}`);
			ok(!fake.requests.some((request) => request.includes(secret)), `a model request holds ${secret}`);
		}
	});
});
