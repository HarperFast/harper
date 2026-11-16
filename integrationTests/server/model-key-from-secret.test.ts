/**
 * A model entry's `apiKey: ${NAME}` is supplied by a global-tier stored secret (harper#4424).
 *
 * The fixture registers custody under the `secretCustody` name, which the main thread starts before
 * the root config load, as Harper Pro's custody does.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startHarper, killHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const SECRET_NAME = 'MODEL_KEY_TEST_API_KEY';
const SECRET_VALUE = 'sk-model-key-from-the-secrets-store';

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

async function operation(ctx: ContextWithHarper, body: object): Promise<Response> {
	return fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body: JSON.stringify(body),
	});
}

async function modelIds(ctx: ContextWithHarper): Promise<string[]> {
	const response = await fetch(`${ctx.harper.httpURL}/v1/models`, { headers: { Authorization: authHeader(ctx) } });
	assert.equal(response.status, 200);
	const body = (await response.json()) as { data: Array<{ id: string }> };
	return body.data.map((model) => model.id);
}

// Workers copy the main thread's environment, so only `threads.count: 0` shows what the main thread registered.
for (const threadCount of [0, 2]) {
	suite(
		`model apiKey from a stored secret (threads.count ${threadCount})`,
		{ skip: process.platform === 'win32' },
		(ctx: ContextWithHarper) => {
			let provider: Server;
			let scratchDirectory: string;
			let startOptions: Parameters<typeof startHarper>[1];
			const authorizationsSeen: string[] = [];

			before(async () => {
				provider = createServer((request, response) => {
					authorizationsSeen.push(request.headers.authorization ?? '');
					request.resume();
					request.on('end', () => {
						response.setHeader('Content-Type', 'application/json');
						response.end(
							JSON.stringify({
								id: 'chatcmpl-test',
								object: 'chat.completion',
								model: 'test-model',
								choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
								usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
							})
						);
					});
				});
				await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));

				scratchDirectory = mkdtempSync(join(tmpdir(), 'model-key-from-secret-'));
				const custodyFile = join(scratchDirectory, 'custody.json');
				writeFileSync(
					custodyFile,
					JSON.stringify(
						generateKeyPairSync('rsa', {
							modulusLength: 2048,
							publicKeyEncoding: { type: 'spki', format: 'pem' },
							privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
						})
					)
				);

				startOptions = {
					config: {
						threads: { count: threadCount },
						rest: { webSocket: true },
						modelsGateway: { enabled: true },
						secretCustody: true,
						models: {
							generative: {
								default: {
									backend: 'openai',
									apiKey: `\${${SECRET_NAME}}`,
									baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
									model: 'test-model',
								},
							},
						},
					},
					env: {
						HARPER_BUILTIN_COMPONENTS:
							'secretCustody=@/integrationTests/server/fixtures/model-key-from-secret/custody.js',
						MODEL_KEY_TEST_CUSTODY_FILE: custodyFile,
					},
				};
				await startHarper(ctx, startOptions);
			});

			after(async () => {
				await teardownHarper(ctx);
				if (provider) await new Promise((resolve) => provider.close(resolve));
				if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
			});

			test('the entry is not registered while nothing supplies the key', async () => {
				assert.ok(!(await modelIds(ctx)).includes('default'));
			});

			test('after set_secret and a restart, the model serves with the stored key', async () => {
				const stored = await operation(ctx, {
					operation: 'set_secret',
					name: SECRET_NAME,
					value: SECRET_VALUE,
					processEnv: true,
				});
				assert.equal(stored.status, 200, await stored.text());

				await killHarper(ctx);
				await startHarper(ctx, startOptions);

				assert.ok((await modelIds(ctx)).includes('default'), 'the model is registered after the restart');
				const completion = await fetch(`${ctx.harper.httpURL}/v1/chat/completions`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
					body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'hello' }] }),
				});
				assert.equal(completion.status, 200, await completion.text());
				assert.equal(authorizationsSeen.at(-1), `Bearer ${SECRET_VALUE}`);
			});
		}
	);
}
