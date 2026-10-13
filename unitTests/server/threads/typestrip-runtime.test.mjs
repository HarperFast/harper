import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { once, on } from 'node:events';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');

function runWithIsolatedRoot(mode, code) {
	let output = '';
	try {
		output = execFileSync(
			process.execPath,
			[...(mode === 'typestrip' ? ['--conditions=typestrip'] : []), '--input-type=module'],
			{
				env: process.env,
				encoding: 'utf8',
				timeout: 30000,
				input: `const { createRequire } = await import('node:module');
			const require = createRequire(${JSON.stringify(pathToFileURL(resolve(root, 'package.json')).href)});
			const { materializePerPidRoot } = require(${JSON.stringify(resolve(root, 'unitTests/perPidRoot.js'))});
			process.env.ROOTPATH = materializePerPidRoot();
			console.log('fixture-root ' + process.pid);
			${code}
			process.exit(0);`,
			}
		);
		return output.replace(/^fixture-root \d+\r?\n/, '').trim();
	} catch (error) {
		output = error.stdout?.toString() ?? '';
		throw error;
	} finally {
		const pid = /^fixture-root (\d+)\r?\n/.exec(output)?.[1];
		if (pid) rmSync(resolve(root, 'unitTests/envDir', pid), { recursive: true, force: true });
	}
}

describe('TypeStrip runtime boundaries', () => {
	it('selects direct JSON codecs before serving REST and subscription messages', () => {
		for (const mode of ['compiled', 'typestrip']) {
			for (const bigint of [false, true]) {
				const prefix = mode === 'compiled' ? 'dist/' : '';
				const extension = mode === 'compiled' ? 'js' : 'ts';
				const runtimeUrl = (path) => pathToFileURL(resolve(root, `${prefix}${path}.${extension}`)).href;
				const output = runWithIsolatedRoot(
					mode,
					`
					const assert = (await import('node:assert')).default;
					const { readFileSync, writeFileSync } = await import('node:fs');
					const configPath = process.env.ROOTPATH + '/harper-config.yaml';
					const YAML = require('yaml');
					const config = YAML.parseDocument(readFileSync(configPath, 'utf8'));
					config.setIn(['serialization', 'bigInt'], ${bigint});
					writeFileSync(configPath, config.toString());
					await import(${JSON.stringify(runtimeUrl('server/threads/threadServer'))});
					const env = await import(${JSON.stringify(runtimeUrl('utility/environment/environmentManager'))});
					env.initSync(); assert.strictEqual(env.get('serialization_bigInt'), ${bigint});
					const codecs = await import(${JSON.stringify(runtimeUrl('server/serverHelpers/contentTypes'))});
					const jsonStream = await import(${JSON.stringify(runtimeUrl('server/serverHelpers/JSONStream'))});
					const custom = value => 'custom:' + value;
					codecs.contentTypes.set('test/custom-json', { serialize: custom });
					const { runStartup } = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
					await runStartup();
					const expected = ${bigint} ? jsonStream.stringify : JSON.stringify;
					assert.strictEqual(codecs.getMessageSerializer(), expected);
					for (const type of ['application/json', '*/*', '']) assert.strictEqual(codecs.contentTypes.get(type).serialize, expected);
					assert.strictEqual(codecs.contentTypes.get('test/custom-json').serialize, custom);
					const request = { headers: { get: () => 'application/json' } };
					const response = { headers: new Map() };
					assert.strictEqual(codecs.serialize({ value: 42 }, request, response), '{"value":42}');
					assert.strictEqual(codecs.serializeMessage({ value: 42 }, request), '{"value":42}');
					assert.strictEqual(request.serialize, expected);
					const bigValue = { value: 9007199254740993n };
					if (${bigint}) {
						assert.strictEqual(codecs.serialize(bigValue, request, response), '{"value":9007199254740993}');
						assert.strictEqual(codecs.getDeserializer('application/json')(Buffer.from('{"value":9007199254740993}')).value, bigValue.value);
					} else {
						assert.throws(() => codecs.serializeMessage(bigValue, request), error => error.message === 'Cannot serialize BigInt to JSON');
						assert.strictEqual(codecs.getMessageSerializer()({ value: 42, extra: true }, ['value'], 2), JSON.stringify({ value: 42 }, null, 2));
						assert.strictEqual(codecs.getDeserializer('application/json')(Buffer.from('{"value":9007199254740993}')).value, 9007199254740992);
					}
					const ndjson = codecs.contentTypes.get('application/x-ndjson').serializeStream([{ value: 42 }]);
					let streamed = ''; for await (const chunk of ndjson) streamed += chunk;
					assert.strictEqual(streamed, '{"value":42}\\n');
					console.log('direct configured codecs served');
				`
				);
				assert.strictEqual(output, 'direct configured codecs served', mode + ':' + bigint);
			}
		}
	});

	it('honors disabled and enabled response compression after serialization startup', () => {
		for (const mode of ['compiled', 'typestrip']) {
			for (const threshold of [0, 32]) {
				const prefix = mode === 'compiled' ? 'dist/' : '';
				const extension = mode === 'compiled' ? 'js' : 'ts';
				const runtimeUrl = (path) => pathToFileURL(resolve(root, `${prefix}${path}.${extension}`)).href;
				const output = runWithIsolatedRoot(
					mode,
					`
					const assert = (await import('node:assert')).default;
					const { readFileSync, writeFileSync } = await import('node:fs');
					const YAML = require('yaml');
					const configPath = process.env.ROOTPATH + '/harper-config.yaml';
					const config = YAML.parseDocument(readFileSync(configPath, 'utf8'));
					config.setIn(['http', 'compressionThreshold'], ${threshold});
					writeFileSync(configPath, config.toString());
					await import(${JSON.stringify(runtimeUrl('server/threads/threadServer'))});
					const codecs = await import(${JSON.stringify(runtimeUrl('server/serverHelpers/contentTypes'))});
					const { runStartup } = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
					await runStartup();
					const value = { value: 'x'.repeat(100) };
					const request = { headers: { asObject: { accept: 'application/json', 'accept-encoding': 'br' } } };
					const response = { headers: new Map() };
					const body = await codecs.serialize(value, request, response);
					if (${threshold}) {
						const { brotliDecompressSync } = await import('node:zlib');
						assert.strictEqual(response.headers.get('Content-Encoding'), 'br');
						assert.ok(body instanceof Uint8Array);
						assert.strictEqual(brotliDecompressSync(body).toString(), JSON.stringify(value));
					} else {
						assert.strictEqual(response.headers.has('Content-Encoding'), false);
						assert.strictEqual(body, JSON.stringify(value));
					}
					console.log('configured response compression served');
					`
				);
				assert.strictEqual(output, 'configured response compression served', mode);
			}
		}
	});

	it('keeps rotation disabled after rapid cold reconfiguration', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const runtimeUrl = pathToFileURL(
				resolve(
					root,
					`${mode === 'compiled' ? 'dist/' : ''}utility/logging/harper_logger.${mode === 'compiled' ? 'js' : 'ts'}`
				)
			).href;
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { readFileSync, writeFileSync, existsSync, readdirSync } = await import('node:fs');
				const { setTimeout: delay } = await import('node:timers/promises');
				const { waitFor } = require(${JSON.stringify(resolve(root, 'unitTests/waitFor.js'))});
				const configPath = process.env.ROOTPATH + '/harper-config.yaml';
				const YAML = require('yaml');
				const config = YAML.parseDocument(readFileSync(configPath, 'utf8'));
				config.deleteIn(['logging', 'rotation']);
				writeFileSync(configPath, config.toString());
				const { createLogger, updateLogger } = await import(${JSON.stringify(runtimeUrl)});
				const path = process.env.ROOTPATH + '/rapid.log';
				const archives = process.env.ROOTPATH + '/rapid-archives';
				const logger = createLogger({ path, level: 'info', stdStreams: false });
				const rotation = { interval: '0.001s', auditInterval: 10, compress: false, path: archives };
				updateLogger(logger, { path, rotation }, undefined, logger);
				updateLogger(logger, { path, rotation: { ...rotation, retention: '1d' } }, undefined, logger);
				updateLogger(logger, { path }, undefined, logger);
				logger.info('rotation must stay disabled');
				await delay(600);
				assert.deepStrictEqual(existsSync(archives) ? readdirSync(archives) : [], []);
				assert.match(readFileSync(path, 'utf8'), /rotation must stay disabled/);
				assert.doesNotMatch(readFileSync(path, 'utf8'), /Error initializing log rotator/);
				updateLogger(logger, { path, rotation }, undefined, logger);
				await waitFor(() => existsSync(archives) && readdirSync(archives).length > 0, { timeout: 3000 });
				updateLogger(logger, { path }, undefined, logger);
				await delay(200);
				const ended = readdirSync(archives);
				await delay(200);
				assert.deepStrictEqual(readdirSync(archives), ended);
				logger.closeLogFile();
				console.log('rotation remained disabled');
			`
			);
			assert.strictEqual(output, 'rotation remained disabled', mode);
		}
	});

	it('drains scopes without binding when shutdown interrupts HTTP startup', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const workerPath = resolve(
				root,
				`${mode === 'compiled' ? 'dist/' : ''}server/threads/threadServer.${mode === 'compiled' ? 'js' : 'ts'}`
			);
			const execArgv = [
				...(mode === 'typestrip' ? ['--conditions=typestrip'] : []),
				'--require',
				resolve(import.meta.dirname, 'fixtures/startup-shutdown.cjs'),
			];
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { Worker } = await import('node:worker_threads');
				const { once } = await import('node:events');
				const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: ${JSON.stringify(execArgv)}, workerData: { addPorts: [], addThreadIds: [] } });
				const messages = []; worker.on('message', message => messages.push(message));
				try {
					while (!messages.some(message => message.type === 'startup-held')) await once(worker, 'message', { signal: AbortSignal.timeout(3000) });
					worker.postMessage({ type: 'shutdown', restartNumber: 2 });
					worker.postMessage({ type: 'release-startup' });
					const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(3000) });
					assert.strictEqual(code, 0);
					assert.ok(messages.some(message => message.type === 'scope-disposed'));
					assert.ok(messages.some(message => message.type === 'startup-drained'));
					assert.strictEqual(messages.some(message => message.type === 'child_started' || message.type === 'child_startup_phase'), false);
				} finally { if (worker.threadId !== -1) await worker.terminate(); }
				console.log('startup shutdown drained');
			`
			);
			assert.strictEqual(output, 'startup shutdown drained', mode);
		}
	});

	it('drains the held component scope when shutdown interrupts component loading', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const workerPath = resolve(
				root,
				`${mode === 'compiled' ? 'dist/' : ''}server/threads/threadServer.${mode === 'compiled' ? 'js' : 'ts'}`
			);
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { readFileSync, writeFileSync } = await import('node:fs');
				const YAML = require('yaml');
				const configPath = process.env.ROOTPATH + '/harper-config.yaml';
				const config = YAML.parseDocument(readFileSync(configPath, 'utf8'));
				config.set('startupShutdownProbe', {});
				writeFileSync(configPath, config.toString());
				process.env.HARPER_BUILTIN_COMPONENTS = 'startupShutdownProbe=' + ${JSON.stringify(resolve(import.meta.dirname, 'fixtures/component-shutdown.cjs'))};
				const { Worker } = await import('node:worker_threads');
				const { once } = await import('node:events');
				const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: ${JSON.stringify(mode === 'typestrip' ? ['--conditions=typestrip'] : [])}, workerData: { addPorts: [], addThreadIds: [] } });
				const messages = []; worker.on('message', message => messages.push(message));
				const deadline = AbortSignal.timeout(5000);
				try {
					while (!messages.some(message => message.type === 'component-held')) await once(worker, 'message', { signal: deadline });
					worker.postMessage({ type: 'shutdown', restartNumber: 2 });
					worker.postMessage({ type: 'release-component' });
					const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(3000) });
					assert.strictEqual(code, 0);
					assert.ok(messages.some(message => message.type === 'component-disposed'));
					assert.ok(messages.some(message => message.type === 'child_startup_phase' && message.phase === 'loading components'));
					assert.strictEqual(messages.some(message => message.type === 'child_started' || (message.type === 'child_startup_phase' && message.phase !== 'loading components')), false);
				} finally { if (worker.threadId !== -1) await worker.terminate(); }
				console.log('component shutdown drained');
			`
			);
			assert.strictEqual(output, 'component shutdown drained', mode);
		}
	});

	it('preserves environment-selected built-ins through startup', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const runtimeUrl = (path) => pathToFileURL(resolve(root, `${prefix}${path}.${extension}`)).href;
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				process.env.HARPER_BUILTIN_COMPONENTS = 'agent=@/test/agent,operationsApi=@/test/operationsApi';
				const { TRUSTED_RESOURCE_PLUGINS } = await import(${JSON.stringify(runtimeUrl('components/componentLoader'))});
				const { runStartup } = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
				await runStartup();
				assert.strictEqual(TRUSTED_RESOURCE_PLUGINS.agent, '@/test/agent');
				assert.strictEqual(TRUSTED_RESOURCE_PLUGINS.operationsApi, '@/test/operationsApi');
				console.log('built-in overrides preserved');
			`
			);
			assert.strictEqual(output, 'built-in overrides preserved', mode);
		}
	});

	it('writes conditional logger warnings before startup runs', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const runtimeUrl = (path) => pathToFileURL(resolve(root, `${prefix}${path}.${extension}`)).href;
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { readFileSync } = await import('node:fs');
				const { join } = await import('node:path');
				assert.strictEqual(typeof globalThis.module, 'undefined');
				const { createLogger, setMainLogger } = await import(${JSON.stringify(runtimeUrl('utility/logging/harper_logger'))});
				const logPath = join(process.env.ROOTPATH, 'before-startup.log');
				setMainLogger(createLogger({ path: logPath, level: 'warn', stdStreams: false }));
				const { logger } = await import(${JSON.stringify(runtimeUrl('utility/logging/logger'))});
				const { hasStarted } = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
				assert.strictEqual(hasStarted(), false);
				logger.warn('conditional warning before startup');
				assert.match(readFileSync(logPath, 'utf8'), /conditional warning before startup/);
				console.log('pre-startup warning written');
			`
			);
			assert.strictEqual(output, 'pre-startup warning written', mode);
		}
	});

	it('skips empty component configuration without reporting a load error', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const runtimeUrl = (path) => pathToFileURL(resolve(root, `${prefix}${path}.${extension}`)).href;
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { mkdirSync, writeFileSync } = await import('node:fs');
				const { join } = await import('node:path');
				const componentDirectory = join(process.env.ROOTPATH, 'empty-component');
				mkdirSync(componentDirectory); writeFileSync(join(componentDirectory,'config.yaml'),'# empty configuration\\n');
				const { loadComponent, trackBootOutcomes, bootVerdictOf } = await import(${JSON.stringify(runtimeUrl('components/componentLoader'))});
				const { Resources } = await import(${JSON.stringify(runtimeUrl('resources/Resources'))});
				trackBootOutcomes(['empty-component']);
				const resources = new Resources();
				await loadComponent(componentDirectory,resources,'test-origin');
				assert.deepStrictEqual(bootVerdictOf('empty-component').failures, []);
				assert.strictEqual(resources.get(''), undefined);
				console.log('empty configuration skipped');
			`
			);
			assert.strictEqual(output, 'empty configuration skipped', mode);
		}
	});

	it('records configured analytics after the real cold server graph starts', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const runtimeUrl = (path) => pathToFileURL(resolve(root, `${prefix}${path}.${extension}`)).href;
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				await import(${JSON.stringify(runtimeUrl('server/threads/threadServer'))});
				const env = await import(${JSON.stringify(runtimeUrl('utility/environment/environmentManager'))});
				env.initSync(); assert.ok(env.get('analytics_aggregatePeriod') > -1);
				const { runStartup } = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
				await runStartup();
				const { recordAction, addAnalyticsListener, setAnalyticsEnabled } = await import(${JSON.stringify(runtimeUrl('resources/analytics/write'))});
				const reports = new Promise((resolve,reject) => {
					const timeout = setTimeout(() => reject(new Error('configured analytics did not record a cold-start sample')),5000);
					addAnalyticsListener(metrics => {
						const metric = metrics.find(metric => metric.metric === 'typestrip-configured-sample');
						if (metric) { clearTimeout(timeout); resolve(metric); }
					});
				});
				recordAction(7,'typestrip-configured-sample');
				assert.strictEqual((await reports).mean,7);
				setAnalyticsEnabled(false);
				const { closeLoadedDatabases } = await import(${JSON.stringify(runtimeUrl('resources/databases'))});
				await closeLoadedDatabases();
				console.log('configured analytics recorded');
			`
			);
			assert.strictEqual(output, 'configured analytics recorded', mode);
		}
	});

	it('exposes the declared public globals in source and compiled facades and user workers', async () => {
		const names = [
			'contentTypes',
			'createBlob',
			'databases',
			'logger',
			'models',
			'operation',
			'Resource',
			'secrets',
			'server',
			'tables',
			'threads',
			'transaction',
		];
		for (const mode of ['compiled', 'typestrip']) {
			const modulePath = pathToFileURL(resolve(root, mode === 'compiled' ? 'dist/index.js' : 'index.ts')).href;
			const output = execFileSync(
				process.execPath,
				[...(mode === 'typestrip' ? ['--conditions=typestrip'] : []), '--input-type=module'],
				{
					input: `const assert = (await import('node:assert')).default;
				const facade = await import(${JSON.stringify(modulePath)});
				const names = ${JSON.stringify(names)};
				assert.deepStrictEqual(Object.keys(facade).filter(name => names.includes(name)).sort(), names.sort());
				for (const name of names) assert.strictEqual(facade[name], globalThis[name], name);
				assert.strictEqual(typeof facade.Resource, 'function');
				assert.strictEqual(typeof facade.operation, 'function');
				assert.strictEqual(typeof facade.server.http, 'function');
				assert.ok(new facade.Resource('public-facade') instanceof facade.Resource);
				console.log('public values preserved'); process.exit(0);`,
					env: process.env,
					encoding: 'utf8',
					timeout: 30000,
				}
			);
			assert.strictEqual(output.trim(), 'public values preserved', mode);
			const worker = new Worker(resolve(root, 'unitTests/bin/user-thread.js'), {
				execArgv: mode === 'typestrip' ? ['--conditions=typestrip'] : [],
				workerData: { noServerStart: true, addPorts: [], addThreadIds: [] },
			});
			try {
				for await (const [message] of on(worker, 'message', { signal: AbortSignal.timeout(30000) })) {
					if (!Object.hasOwn(message, 'hasResource')) continue;
					assert.deepStrictEqual(message, { hasResource: true, hasServer: true }, mode);
					break;
				}
			} finally {
				await worker.terminate();
			}
		}
	});

	it('keeps HTTP workers alive through startup hooks with unreferenced completion sources', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const workerPath = resolve(
				root,
				`${mode === 'compiled' ? 'dist/' : ''}server/threads/threadServer.${mode === 'compiled' ? 'js' : 'ts'}`
			);
			const execArgv = [
				...(mode === 'typestrip' ? ['--conditions=typestrip'] : []),
				'--require',
				resolve(import.meta.dirname, 'fixtures/startup-ref.cjs'),
			];
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { Worker } = await import('node:worker_threads');
				const { once } = await import('node:events');
				const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: ${JSON.stringify(execArgv)}, workerData: { addPorts: [], addThreadIds: [] } });
				const messages = []; worker.on('message', message => messages.push(message));
				try {
					const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(10000) });
					assert.strictEqual(code, 0);
					assert.ok(messages.some(message => message.type === 'startup-ref' && message.held === true));
					assert.ok(messages.some(message => message.type === 'startup-hook-completed'));
				} finally { if (worker.threadId !== -1) await worker.terminate(); }
				console.log('startup hook completed');`
			);
			assert.strictEqual(output, 'startup hook completed', mode);
		}
	});

	it('passes the source condition to actual managed workers without NODE_OPTIONS', () => {
		const manager = pathToFileURL(resolve(root, 'server/threads/manageThreads.ts')).href;
		const fixture = resolve(import.meta.dirname, 'fixtures/runtime-condition.cjs');
		const output = execFileSync(process.execPath, ['--conditions=typestrip', '--input-type=module'], {
			input: `const { once } = await import('node:events');
				const { startWorker } = await import(${JSON.stringify(manager)});
				const worker = startWorker(${JSON.stringify(fixture)}, { name: 'runtime-condition', autoRestart: false });
				try {
					const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) });
					console.log(JSON.stringify(message));
				} finally { await worker.terminate(); }
				process.exit(0);`,
			env: { ...process.env, NODE_OPTIONS: '' },
			encoding: 'utf8',
			timeout: 30000,
		});
		const message = JSON.parse(output.trim());
		assert.strictEqual(message.modulePath, resolve(root, 'server/Server.ts'));
		assert.ok(message.execArgv.includes('--conditions=typestrip'));
	});

	it('keeps default tagged logs on the current main sink and explicit loggers on their own sink', () => {
		mkdirSync(resolve(root, 'cache'), { recursive: true });
		const directory = mkdtempSync(resolve(root, 'cache/tagged-logger-'));
		try {
			for (const mode of ['compiled', 'typestrip']) {
				const modulePath = pathToFileURL(
					resolve(
						root,
						`${mode === 'compiled' ? 'dist/' : ''}utility/logging/harper_logger.${mode === 'compiled' ? 'js' : 'ts'}`
					)
				).href;
				const output = execFileSync(
					process.execPath,
					[...(mode === 'typestrip' ? ['--conditions=typestrip'] : []), '--input-type=module'],
					{
						input: `const assert = (await import('node:assert')).default;
						const { readFileSync, existsSync } = await import('node:fs');
						const { createLogger, setMainLogger, loggerWithTag } = await import(${JSON.stringify(modulePath)});
						const firstPath = ${JSON.stringify(resolve(directory, mode + '-first.log'))};
						const secondPath = ${JSON.stringify(resolve(directory, mode + '-second.log'))};
						const first = createLogger({path:firstPath,level:'info',stdStreams:false});
						setMainLogger(first);
						const implicit = loggerWithTag('implicit');
						const explicit = loggerWithTag('explicit', false, first);
						const conditional = loggerWithTag('conditional', true);
						assert.strictEqual(conditional.debug, null);
						implicit.notify('before replacement');
						setMainLogger(createLogger({path:secondPath,level:'trace',stdStreams:false}));
						implicit.notify('after replacement');
						explicit.notify('explicit remains');
						assert.strictEqual(conditional.debug, null);
						assert.ok(existsSync(secondPath), 'implicit tag did not follow new main sink');
						assert.match(readFileSync(secondPath,'utf8'), /\\[implicit\\].*after replacement/);
						const firstText = readFileSync(firstPath,'utf8');
						assert.match(firstText, /\\[explicit\\].*explicit remains/);
						assert.doesNotMatch(firstText, /after replacement/);
						console.log('tagged logs preserved'); process.exit(0);`,
						env: process.env,
						encoding: 'utf8',
						timeout: 30000,
					}
				);
				assert.strictEqual(output.trim(), 'tagged logs preserved', mode);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('initializes the legacy launcher before authenticating a session cookie', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const output = runWithIsolatedRoot(
				mode,
				`const assert = (await import('node:assert')).default;
					await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}launchServiceScripts/launchHarperDB.js`)).href)});
					const { hasStarted, runStartup } = await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}utility/lifecycle.${extension}`)).href)});
					assert.strictEqual(hasStarted(), true);
					await runStartup();
					const { authentication } = await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}security/auth.${extension}`)).href)});
					const result = await authentication({headers:{asObject:{host:'example.test',cookie:'example_test-hdb-session=missing'}},ip:'203.0.113.1',method:'GET',pathname:'/',protocol:'http'}, async () => ({status:200,headers:new Headers(),body:{ok:true}}));
					assert.strictEqual(result.status, 200);
					const { closeLoadedDatabases } = await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}resources/databases.${extension}`)).href)});
					await closeLoadedDatabases();
					console.log('launcher initialized');`
			);
			assert.strictEqual(output.trim(), 'launcher initialized', mode);
		}
	});

	it('parses CSV streams through the shared file-load helper in both modes', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const modulePath = pathToFileURL(
				resolve(root, `${mode === 'compiled' ? 'dist/' : ''}utility/common_utils.${mode === 'compiled' ? 'js' : 'ts'}`)
			).href;
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { Readable } = await import('node:stream');
				const { parsePromise } = await import(${JSON.stringify(modulePath)});
				const rows = [];
				await parsePromise(Readable.from([${JSON.stringify('\uFEFFid,name\n1,first\n2,second\n')}]), (reject, result) => {
					if (result.errors.length) reject(new Error(JSON.stringify(result.errors)));
					rows.push(...result.data);
				}, value => value);
				assert.deepStrictEqual(rows, [{ id: '1', name: 'first' }, { id: '2', name: 'second' }]);
				console.log('CSV stream parsed');`
			);
			assert.strictEqual(output, 'CSV stream parsed', mode);
		}
	});

	it('imports the CLI without running a command', () => {
		const cli = pathToFileURL(resolve(root, 'bin/harper.ts')).href;
		const services = pathToFileURL(resolve(root, 'utility/processManagement/servicesConfig.ts')).href;
		const output = execFileSync(
			process.execPath,
			[
				'--conditions=typestrip',
				'--input-type=module',
				'-e',
				`const cli = await import(${JSON.stringify(cli)}); const services = await import(${JSON.stringify(services)}); const { existsSync } = await import('node:fs'); for (const config of [services.generateMainServerConfig(), services.generateRestart()]) { if (!config.script.endsWith('.ts') || !existsSync(config.script)) throw new Error('Missing source service entry'); } console.log(typeof cli.harper);`,
			],
			{ env: process.env, encoding: 'utf8', timeout: 30000 }
		);
		assert.strictEqual(output.trim(), 'function');
	});

	it('resolves compiled service entries inside the distribution', () => {
		const services = require('#src/utility/processManagement/servicesConfig');
		for (const config of [services.generateMainServerConfig(), services.generateRestart()]) {
			assert.ok(config.script.startsWith(resolve(root, 'dist') + '/'));
			assert.ok(config.script.endsWith('.js'));
			assert.ok(existsSync(config.script));
		}
	});

	it('chooses runtime paths from canonical module locations', () => {
		mkdirSync(resolve(root, 'cache'), { recursive: true });
		const directory = mkdtempSync(resolve(root, 'cache/typestrip-links-'));
		const link = resolve(directory, 'harper');
		try {
			symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
			for (const mode of ['compiled', 'typestrip']) {
				const modulePath = resolve(link, `${mode === 'compiled' ? 'dist/' : ''}utility/packageUtils.js`);
				const output = execFileSync(
					process.execPath,
					[
						'--preserve-symlinks',
						'-e',
						`(async () => { const { RUNTIME_SRC_ROOT, RUNTIME_FILE_EXT, loadRuntimeModule } = require(${JSON.stringify(modulePath)}); const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path'); const imported = await import(pathToFileURL(resolve(${JSON.stringify(link)}, ${JSON.stringify(mode === 'compiled' ? 'dist/dataLayer/search.js' : 'dataLayer/search.ts')}))); if (loadRuntimeModule('dataLayer/search').search !== imported.search) throw new Error('Duplicate module instance'); console.log(JSON.stringify([RUNTIME_SRC_ROOT, RUNTIME_FILE_EXT])); process.exit(0); })().catch(error => { console.error(error); process.exit(1); });`,
					],
					{ encoding: 'utf8', timeout: 30000 }
				);
				assert.deepStrictEqual(JSON.parse(output), [
					mode === 'compiled' ? resolve(root, 'dist') : root,
					mode === 'compiled' ? '.js' : '.ts',
				]);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('keeps SQL cold until first use in both runtime graphs', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const entry = pathToFileURL(resolve(root, `${prefix}server/threads/threadServer.${extension}`)).href;
			const helpers = pathToFileURL(resolve(root, `${prefix}utility/packageUtils.js`)).href;
			const output = execFileSync(
				process.execPath,
				[...(mode === 'typestrip' ? ['--conditions=typestrip'] : []), '--input-type=module'],
				{
					input: `const { registerHooks } = await import('node:module');
					const resolutions = [];
					registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); resolutions.push(result.url); return result; } });
					await import(${JSON.stringify(entry)});
					if (resolutions.some(url => url.includes('/alasql/') || url.includes('/mathjs/') || url.endsWith('/sqlTranslator/index.${extension}'))) throw new Error('SQL loaded during boot');
					const { loadRuntimeModule } = await import(${JSON.stringify(helpers)});
					const sql = loadRuntimeModule('sqlTranslator/index');
					if (typeof sql.evaluateSQL !== 'function' || typeof sql.convertSQLToAST !== 'function' || typeof loadRuntimeModule('dataLayer/SQLSearch').default !== 'function' || typeof loadRuntimeModule('sqlTranslator/SelectValidator').default !== 'function') throw new Error('Cold module export missing');
					if (!resolutions.some(url => url.includes('/alasql/'))) throw new Error('Cold dependency observation missing');
					console.log('cold SQL loaded'); process.exit(0);`,
					env: process.env,
					encoding: 'utf8',
					timeout: 30000,
				}
			);
			assert.strictEqual(output.trim(), 'cold SQL loaded', mode);
		}
	});

	it('preserves Resource inheritance through lazy source classes', () => {
		const modules = [
			['resources/ErrorResource', 'ErrorResource'],
			['security/certificateVerification/certificateVerificationSource', 'CertificateVerificationSource'],
		];
		const { Resource } = require('#src/resources/Resource');
		for (const [modulePath, name] of modules) {
			const Source = require(`#src/${modulePath}`)[name];
			class Derived extends Source {}
			assert.strictEqual(Object.getPrototypeOf(Source), Resource);
			assert.ok(new Derived(new Error('test')) instanceof Derived);
		}
		const output = execFileSync(process.execPath, ['--conditions=typestrip', '--input-type=module'], {
			input: `const { Resource } = await import(${JSON.stringify(pathToFileURL(resolve(root, 'resources/Resource.ts')).href)}); for (const [modulePath, name] of ${JSON.stringify(modules)}) { const Source = (await import(new URL(modulePath + '.ts', ${JSON.stringify(pathToFileURL(root + '/').href)})))[name]; class Derived extends Source {} if (Object.getPrototypeOf(Source) !== Resource || !(new Derived(new Error('test')) instanceof Derived)) throw new Error('Lost Resource inheritance'); } console.log('inherited'); process.exit(0);`,
			env: process.env,
			encoding: 'utf8',
			timeout: 30000,
		});
		assert.strictEqual(output.trim(), 'inherited');
	});

	it('keeps worker callbacks registered before the cyclic runtime finishes loading', () => {
		const router = pathToFileURL(resolve(root, 'server/threads/socketRouter.ts')).href;
		const state = pathToFileURL(resolve(root, 'server/threads/threadMessageState.ts')).href;
		const operations = pathToFileURL(resolve(root, 'server/serverHelpers/serverUtilities.ts')).href;
		const dispatch = pathToFileURL(resolve(root, 'server/serverHelpers/operationDispatchState.ts')).href;
		const output = execFileSync(process.execPath, ['--conditions=typestrip', '--input-type=module'], {
			input: `const { workerHooks, listenersByType } = await import(${JSON.stringify(state)}); const schemaListener = () => {}; listenersByType.set('schema', [schemaListener]); const router = await import(${JSON.stringify(router)}); if (listenersByType.get('schema')?.[0] !== schemaListener) throw new Error('Lost event listener'); if (workerHooks.reconcile !== router.reconcileIsolatedWorkers || typeof workerHooks.monitorListener !== 'function') throw new Error('Lost startup registration'); const operations = await import(${JSON.stringify(operations)}); const { operationDispatchState } = await import(${JSON.stringify(dispatch)}); if (operationDispatchState.local?.chooseOperation !== operations.chooseOperation || operationDispatchState.local?.processLocalTransaction !== operations.processLocalTransaction) throw new Error('Lost operation dispatch'); console.log('registered'); process.exit(0);`,
			env: process.env,
			encoding: 'utf8',
			timeout: 30000,
		});
		assert.strictEqual(output.trim(), 'registered');
	});

	it('shares the parent process incarnation with workers without loading the server', async () => {
		const modulePath = require.resolve('#src/server/threads/processIncarnation');
		const { processIncarnation } = require(modulePath);
		assert.match(processIncarnation, /^[a-f0-9]{16}$/);
		const worker = new Worker(
			`const { parentPort } = require('node:worker_threads'); parentPort.postMessage(require(${JSON.stringify(modulePath)}).processIncarnation);`,
			{ eval: true, workerData: { processIncarnation } }
		);
		try {
			const [inherited] = await once(worker, 'message');
			assert.strictEqual(inherited, processIncarnation);
		} finally {
			await worker.terminate();
		}
	});

	it('imports the CLI and server graph in evaluated workers without starting HTTP servers', async () => {
		for (const mode of ['compiled', 'typestrip']) {
			const cli = pathToFileURL(
				resolve(root, `${mode === 'compiled' ? 'dist/' : ''}bin/harper.${mode === 'compiled' ? 'js' : 'ts'}`)
			).href;
			const entry = pathToFileURL(
				resolve(
					root,
					`${mode === 'compiled' ? 'dist/' : ''}server/threads/threadServer.${mode === 'compiled' ? 'js' : 'ts'}`
				)
			).href;
			const worker = new Worker(
				`const { parentPort } = require('node:worker_threads'); import(${JSON.stringify(cli)}).then(async cli => { await import(${JSON.stringify(entry)}); const registry = await import(${JSON.stringify(pathToFileURL(resolve(root, `${mode === 'compiled' ? 'dist/' : ''}server/serverRegistry.${mode === 'compiled' ? 'js' : 'ts'}`)).href)}); parentPort.postMessage({ type: 'import-complete', cli: typeof cli.harper, started: Object.values(registry.SERVERS).some(server => server.listening) }); }).catch(error => parentPort.postMessage({ type: 'import-complete', error: error.stack }));`,
				{
					eval: true,
					execArgv: mode === 'typestrip' ? ['--conditions=typestrip'] : [],
					workerData: { addPorts: [], addThreadIds: [], restartNumber: 1 },
				}
			);
			try {
				const result = await new Promise((resolve, reject) => {
					const signal = AbortSignal.timeout(30000);
					signal.addEventListener('abort', () => reject(signal.reason), { once: true });
					worker.on('message', (message) => {
						if (message?.type === 'import-complete') resolve(message);
					});
					worker.once('error', reject);
					worker.once('exit', (code) => reject(new Error(`Worker exited before importing the server (${code})`)));
				});
				assert.strictEqual(result.error, undefined, mode);
				assert.strictEqual(result.cli, 'function', mode);
				assert.strictEqual(result.started, false, mode);
			} finally {
				await worker.terminate();
			}
		}
	});

	it('refreshes fresh-install configuration and bounds the real Node authorization cache', function () {
		if (process.versions.bun) this.skip();
		for (const mode of ['compiled', 'typestrip']) {
			const runtimeUrl = (path) =>
				pathToFileURL(
					resolve(root, `${mode === 'compiled' ? 'dist/' : ''}${path}.${mode === 'compiled' ? 'js' : 'ts'}`)
				).href;
			const observations = {
				[runtimeUrl('security/jsLoader')]:
					'globalThis.snapshots.loader = () => ({lockdown:APPLICATIONS_LOCKDOWN, fsAllowed:ALLOWED_NODE_BUILTIN_MODULES.has("fs"), pathAllowed:ALLOWED_NODE_BUILTIN_MODULES.has("path")});',
				[runtimeUrl('server/mqtt')]: 'globalThis.snapshots.mqtt = () => AUTHORIZE_LOCAL;',
				[runtimeUrl('server/serverHelpers/registeredOperations')]:
					'globalThis.snapshots.timeout = () => EXECUTE_TIMEOUT_MS;',
				[runtimeUrl('dataLayer/bulkLoad')]: 'globalThis.snapshots.directory = () => TEMP_DOWNLOAD_DIR;',
				[runtimeUrl('server/threads/threadServer')]: 'globalThis.snapshots.debug = () => debugThreads;',
			};
			const signature =
				mode === 'typestrip' ? 'export function get(propName: string): any {' : 'function get(propName) {';
			const observer =
				' if (globalThis.coldRecording) globalThis.coldReads.push({key:propName,caller:new Error().stack.split("\\n")[2]}); ';
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const fs = require('node:fs');
				const { registerHooks } = await import('node:module');
				const { fileURLToPath } = await import('node:url');
				const configPath = process.env.ROOTPATH + '/harper-config.yaml';
				fs.unlinkSync(configPath);
				delete process.env.DEV_MODE; delete process.env.HARPER_SET_CONFIG;
				globalThis.snapshots = {}; globalThis.hookControls = [];
				globalThis.coldReads = []; globalThis.coldRecording = true;
				const observations = ${JSON.stringify(observations)};
				registerHooks({ load(url, context, next) {
					const result = next(url, context);
					if (url === ${JSON.stringify(runtimeUrl('utility/environment/environmentManager'))}) {
						const source = (result.source || fs.readFileSync(fileURLToPath(url), 'utf8')).toString();
						assert.ok(source.includes(${JSON.stringify(signature)}));
						return {...result, source:source.replace(${JSON.stringify(signature)}, ${JSON.stringify(signature + observer)})};
					}
					if (observations[url]) {
						globalThis.hookControls.push({url,beforeConfig:!fs.existsSync(configPath)});
						return {...result, source:(result.source || fs.readFileSync(fileURLToPath(url), 'utf8')).toString() + '\\n' + observations[url]};
					}
					if (url !== ${JSON.stringify(runtimeUrl('security/auth'))}) return result;
					const source = (result.source || fs.readFileSync(fileURLToPath(url), 'utf8')).toString();
					assert.strictEqual(source.split('setInterval(() => {').length - 1, 1);
					globalThis.hookControls.push({url,beforeConfig:!fs.existsSync(configPath)});
					return {...result, source:source.replace('setInterval(() => {','globalThis.authCacheTimer = setInterval(() => {')};
				} });
				await import(${JSON.stringify(runtimeUrl('bin/run'))});
				globalThis.coldRecording = false;
				assert.strictEqual(globalThis.hookControls.length,6);
				assert.ok(globalThis.hookControls.every(control=>control.beforeConfig));
				assert.strictEqual(globalThis.authCacheTimer,undefined);
				const owners = [...new Set(globalThis.coldReads.map(({key,caller}) => {
					let path = caller.slice(caller.indexOf(${JSON.stringify(root + '/')}) + ${root.length + 1}).split(':')[0];
					if (path.startsWith('dist/')) path = path.slice(5);
					if (path.endsWith('.js')) path = path.slice(0,-3) + '.ts';
					return path + ':' + key.toLowerCase();
				}))].sort();
				assert.deepStrictEqual(owners, ["dataLayer/bulkLoad.ts:hdb_root", "resources/DatabaseTransaction.ts:storage_debuglongtransactions", "resources/DatabaseTransaction.ts:storage_maxtransactionopentime", "resources/DatabaseTransaction.ts:storage_maxtransactionqueuetime", "resources/RecordEncoder.ts:storage_maxreadtransactionopentime", "resources/Table.ts:storage_prefetchwrites", "resources/analytics/write.ts:analytics_aggregateperiod", "resources/auditStore.ts:logging_auditretention", "resources/databases.ts:storage_pagesize", "security/jsLoader.ts:applications_allowedbuiltinmodules", "security/jsLoader.ts:applications_lockdown", "security/tokenAuthentication.ts:authentication_operationtokentimeout", "security/tokenAuthentication.ts:authentication_refreshtokentimeout", "security/user.ts:authentication_hashfunction", "server/mqtt.ts:authentication_authorizelocal", "server/serverHelpers/contentTypes.ts:http_compressionthreshold", "server/serverHelpers/contentTypes.ts:serialization_bigint", "server/serverHelpers/registeredOperations.ts:operationsapi_network_timeout", "server/storageReclamation.ts:storage_reclamation_interval", "server/storageReclamation.ts:storage_reclamation_threshold", "server/threads/manageThreads.ts:threads_heapsnapshotnearlimit", "server/threads/threadServer.ts:threads_debug", "utility/lmdb/OpenDBIObject.ts:storage_caching", "utility/password.ts:authentication_hashfunction"]);
				materializePerPidRoot();
				const YAML = require('yaml');
				const config = YAML.parseDocument(fs.readFileSync(configPath,'utf8'));
				config.setIn(['authentication','cacheTTL'],31337);
				config.setIn(['authentication','authorizeLocal'],false);
				config.setIn(['applications','allowedBuiltinModules'],['path']);
				config.setIn(['applications','lockdown'],'freeze-after-load');
				config.setIn(['operationsApi','network','timeout'],31339);
				config.setIn(['operationsApi','network','domainSocket'],false);
				config.setIn(['threads','debug'],true);
				fs.writeFileSync(configPath,config.toString());
				const env = await import(${JSON.stringify(runtimeUrl('utility/environment/environmentManager'))});
				env.initSync();
				const net = await import('node:net');
				const reservation = net.createServer();
				await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
				const port = reservation.address().port;
				await new Promise(resolve=>reservation.close(resolve));
				env.setProperty('threads_debug_port',port);
				env.setProperty('threads_debug_host','127.0.0.1');
				process.env.DEV_MODE='true';
				const {runStartup} = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
				await runStartup();
				assert.strictEqual(globalThis.authCacheTimer._idleTimeout,31337);
				assert.strictEqual(globalThis.authCacheTimer.hasRef(),false);
				assert.deepStrictEqual(globalThis.snapshots.loader(),{lockdown:'freeze-after-load',fsAllowed:false,pathAllowed:true});
				assert.strictEqual(globalThis.snapshots.mqtt(),false);
				assert.strictEqual(globalThis.snapshots.timeout(),31339);
				assert.strictEqual(globalThis.snapshots.directory(),process.env.ROOTPATH+'/tmp');
				assert.strictEqual(globalThis.snapshots.debug(),true);
				const inspector = await import('node:inspector');
				const inspectorUrl = inspector.url();
				assert.strictEqual(new URL(inspectorUrl).port,String(port));
				const timer = globalThis.authCacheTimer;
				await runStartup();
				assert.strictEqual(globalThis.authCacheTimer,timer);
				assert.strictEqual(inspector.url(),inspectorUrl);
				inspector.close();
				const databases = await import(${JSON.stringify(runtimeUrl('resources/databases'))});
				await databases.closeLoadedDatabases();
				console.log('fresh-install configuration honored');
			`
			);
			assert.strictEqual(output, 'fresh-install configuration honored', mode);
		}
	});

	it('honors final main-thread inspector overrides on configured roots', function () {
		if (process.versions.bun) this.skip();
		for (const mode of ['compiled', 'typestrip']) {
			const runtimeUrl = (path) =>
				pathToFileURL(
					resolve(root, `${mode === 'compiled' ? 'dist/' : ''}${path}.${mode === 'compiled' ? 'js' : 'ts'}`)
				).href;
			for (const [initialDebug, finalDebug] of [
				[false, true],
				[true, false],
				[true, true],
			]) {
				const output = runWithIsolatedRoot(
					mode,
					`
					const assert = (await import('node:assert')).default;
					delete process.env.DEV_MODE; delete process.env.HARPER_SET_CONFIG;
					const fs = require('node:fs'); const YAML = require('yaml');
					const net = await import('node:net');
					const reservations = [net.createServer(),net.createServer()];
					for (const server of reservations) await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
					const [initialPort,finalPort] = reservations.map(server=>server.address().port);
					for (const server of reservations) await new Promise(resolve=>server.close(resolve));
					const configPath = process.env.ROOTPATH + '/harper-config.yaml';
					const config = YAML.parseDocument(fs.readFileSync(configPath,'utf8'));
					config.setIn(['threads','debug'],${initialDebug});
					config.setIn(['threads','debug_port'],initialPort);
					config.setIn(['threads','debug_host'],'127.0.0.1');
					config.setIn(['operationsApi','network','domainSocket'],false);
					fs.writeFileSync(configPath,config.toString());
					await import(${JSON.stringify(runtimeUrl('bin/run'))});
					const inspector = await import('node:inspector');
					assert.strictEqual(inspector.url(),undefined,'main-thread inspector waits for final configuration');
					const env = await import(${JSON.stringify(runtimeUrl('utility/environment/environmentManager'))});
					env.setProperty('threads_debug',${finalDebug});
					env.setProperty('threads_debug_port',finalPort);
					env.setProperty('threads_debug_host','127.0.0.1');
					const {runStartup} = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
					await runStartup();
					if (${finalDebug}) {
						assert.ok(inspector.url(),'main-thread inspector honors the final debug override');
						assert.strictEqual(new URL(inspector.url()).port,String(finalPort));
					} else assert.strictEqual(inspector.url(),undefined);
					inspector.close();
					const {closeLoadedDatabases} = await import(${JSON.stringify(runtimeUrl('resources/databases'))});
					await closeLoadedDatabases();
					console.log('final inspector override honored');
					`
				);
				assert.strictEqual(output, 'final inspector override honored', mode + ':' + initialDebug + ':' + finalDebug);
			}
		}
	});

	it('initializes a configured worker inspector once across import and startup', function () {
		if (process.versions.bun) this.skip();
		for (const mode of ['compiled', 'typestrip']) {
			const runtimeUrl = (path) =>
				pathToFileURL(
					resolve(root, `${mode === 'compiled' ? 'dist/' : ''}${path}.${mode === 'compiled' ? 'js' : 'ts'}`)
				).href;
			const workerCode = `
				const assert = (await import('node:assert')).default;
				const {parentPort} = await import('node:worker_threads');
				parentPort.ref();
				const {registerHooks} = await import('node:module');
				const {readFileSync} = await import('node:fs');
				const {fileURLToPath} = await import('node:url');
				globalThis.inspectorAttempts = 0;
				registerHooks({load(url,context,next) {
					const result = next(url,context);
					if (url !== ${JSON.stringify(runtimeUrl('server/threads/threadServer'))}) return result;
					const source = (result.source || readFileSync(fileURLToPath(url),'utf8')).toString();
					assert.strictEqual(source.split('inspectorInitialized = true;').length - 1,1);
					return {...result,source:source.replace('inspectorInitialized = true;','inspectorInitialized = true; globalThis.inspectorAttempts++;')};
				}});
				await import(${JSON.stringify(runtimeUrl('server/threads/threadServer'))});
				const inspector = await import('node:inspector');
				assert.strictEqual(globalThis.inspectorAttempts,1);
				assert.strictEqual(new URL(inspector.url()).port,String(process.env.EXPECTED_INSPECTOR_PORT));
				const initialUrl = inspector.url();
				const {runStartup} = await import(${JSON.stringify(runtimeUrl('utility/lifecycle'))});
				await runStartup();
				assert.strictEqual(globalThis.inspectorAttempts,1,'startup skips the already initialized worker inspector');
				assert.strictEqual(inspector.url(),initialUrl);
				inspector.close();
				const {closeLoadedDatabases} = await import(${JSON.stringify(runtimeUrl('resources/databases'))});
				await closeLoadedDatabases();
				parentPort.postMessage({type:'inspector-proof'});
			`;
			const output = runWithIsolatedRoot(
				mode,
				`
				delete process.env.DEV_MODE; delete process.env.HARPER_SET_CONFIG;
				const net = await import('node:net'); const reservation = net.createServer();
				await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
				const port = reservation.address().port;
				await new Promise(resolve=>reservation.close(resolve));
				const fs = require('node:fs'); const YAML = require('yaml');
				const configPath = process.env.ROOTPATH + '/harper-config.yaml';
				const config = YAML.parseDocument(fs.readFileSync(configPath,'utf8'));
				config.setIn(['threads','debug'],true);
				config.setIn(['operationsApi','network','domainSocket'],false);
				fs.writeFileSync(configPath,config.toString());
				const {Worker} = await import('node:worker_threads');
				const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(${JSON.stringify(workerCode)})),{
					execArgv:${JSON.stringify(mode === 'typestrip' ? ['--conditions=typestrip'] : [])},
					env:{...process.env,EXPECTED_INSPECTOR_PORT:String(port)},
					workerData:{noServerStart:true,workerIndex:0,workerCount:1,addPorts:[],addThreadIds:[],configOverrides:{threads_debug:true,threads_debug_startingPort:port,threads_debug_host:'127.0.0.1'}}
				});
				try {
					await new Promise((resolve,reject)=>{
						const signal = AbortSignal.timeout(25000);
						signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
						worker.on('message',message=>{if(message.type === 'inspector-proof') resolve();});
						worker.once('error',reject);
						worker.once('exit',code=>reject(new Error('Worker exited before inspector proof: '+code)));
					});
				} finally { await worker.terminate(); }
				console.log('worker inspector initialized once');
				`
			);
			assert.strictEqual(output, 'worker inspector initialized once', mode);
		}
	});
});

describe('TypeStrip core packaging', () => {
	it('links every schema reader and shares the schema in both runtimes', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const readers = [
				'security/user',
				'utility/globalSchema',
				'utility/mount_hdb',
				'upgrade/directives/5-1-0',
				'upgrade/directives/5-2-0',
				'upgrade/directives/5-3-0',
				'dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbDropAttribute',
				'dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbSearch',
			];
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const schema = await import(${JSON.stringify(pathToFileURL(resolve(root, prefix + 'utility/systemSchema.js')).href)});
				for (const url of ${JSON.stringify(readers.map((path) => pathToFileURL(resolve(root, prefix + path + '.' + extension)).href))}) await import(url);
				const { getSystemSchema } = await import(${JSON.stringify(pathToFileURL(resolve(root, prefix + 'utility/globalSchema.' + extension)).href)});
				assert.strictEqual(getSystemSchema(), schema.systemSchema);
				const { closeLoadedDatabases } = await import(${JSON.stringify(pathToFileURL(resolve(root, prefix + 'resources/databases.' + extension)).href)});
				await closeLoadedDatabases();
				console.log('schema readers linked');
			`
			);
			assert.strictEqual(output, 'schema readers linked', mode);
		}
	});

	it('preserves the public base and default extension for relative worker paths', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert')).default;
				const { writeFileSync } = await import('node:fs');
				const { join, relative } = await import('node:path');
				const { once } = await import('node:events');
				const filename = join(process.env.ROOTPATH, 'relative-worker.js');
				writeFileSync(filename, "require('node:worker_threads').parentPort.postMessage('default js worker');");
				const { startWorker } = await import(${JSON.stringify(pathToFileURL(resolve(root, prefix + 'server/threads/manageThreads.' + extension)).href)});
				const worker = startWorker(relative(${JSON.stringify(root)}, filename).slice(0, -3), { name: 'relative-path-probe', autoRestart: false });
				try {
					const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) });
					assert.strictEqual(message, 'default js worker');
				} finally { if (worker.threadId !== -1) await worker.terminate(); }
				console.log('relative worker contract preserved');
			`
			);
			assert.strictEqual(output, 'relative worker contract preserved', mode);
		}
	});

	it('boots embedded core workers and invokes the product CLI only once', () => {
		for (const engine of ['rocksdb', 'lmdb']) {
			const output = runWithIsolatedRoot(
				'compiled',
				`
				process.env.HARPER_STORAGE_ENGINE = ${JSON.stringify(engine)};
				await require(${JSON.stringify(resolve(import.meta.dirname, 'fixtures/embedded-layout.cjs'))}).probeEmbeddedRuntime(${JSON.stringify(root)});
				console.log('embedded runtime preserved');
			`
			);
			assert.strictEqual(output, 'embedded runtime preserved', engine);
		}
	});
});

describe('TypeStrip canary admission', () => {
	for (const scenario of ['admitted', 'refused', 'shutdown-during-load', 'bind-retry']) {
		it(`preserves cleanup and readiness when ${scenario}`, () => {
			for (const mode of ['compiled', 'typestrip']) {
				const workerPath = resolve(
					root,
					`${mode === 'compiled' ? 'dist/' : ''}server/threads/threadServer.${mode === 'compiled' ? 'js' : 'ts'}`
				);
				const output = runWithIsolatedRoot(
					mode,
					`
					const assert = (await import('node:assert')).default;
					const { readFileSync, writeFileSync } = await import('node:fs');
					const { createServer, createConnection } = await import('node:net');
					const { Worker } = await import('node:worker_threads');
					const { once } = await import('node:events');
					const { waitFor } = require(${JSON.stringify(resolve(root, 'unitTests/waitFor.js'))});
					const scenario = ${JSON.stringify(scenario)};
					const pool = scenario === 'bind-retry';
					const reservation = createServer();
					reservation.listen(0, '127.0.0.1');
					await once(reservation, 'listening');
					const port = reservation.address().port;
					if (!pool) await new Promise(resolve => reservation.close(resolve));
					const YAML = require('yaml');
					const configPath = process.env.ROOTPATH + '/harper-config.yaml';
					const config = YAML.parseDocument(readFileSync(configPath, 'utf8'));
					config.set('admissionScopeProbe', {});
					writeFileSync(configPath, config.toString());
					process.env.HARPER_BUILTIN_COMPONENTS = 'admissionScopeProbe=' + ${JSON.stringify(resolve(import.meta.dirname, 'fixtures/admission-scope.cjs'))};
					const worker = new Worker(${JSON.stringify(workerPath)}, {
						execArgv: ${JSON.stringify(mode === 'typestrip' ? ['--conditions=typestrip'] : [])},
						workerData: { addPorts: [], addThreadIds: [], reportsLoad: true, holdProbeLoad: true, probePort: port, probePool: pool, name: pool ? 'replication' : 'http', poolIndex: 0, workerPools: pool ? ['replication'] : [] },
					});
					const messages = [];
					let workerError, exited;
					worker.on('message', message => messages.push(message));
					worker.on('error', error => workerError = error);
					worker.on('exit', code => exited = code);
					const exit = once(worker, 'exit', { signal: AbortSignal.timeout(15000) });
					const wait = type => waitFor(() => {
						if (workerError) throw workerError;
						const fixtureError = messages.find(message => message.type === 'admission-fixture-error');
						if (fixtureError) throw new Error(fixtureError.message);
						const message = messages.find(message => message.type === type);
						if (!message && exited !== undefined) throw new Error('Worker exited before ' + type + ': ' + exited);
						return message;
					}, { timeout: 10000, message: () => 'Waiting for ' + type + '; got ' + messages.map(message => message.type + ':' + (message.phase ?? '')).join(', ') });
					try {
						await wait('admission-scope-loaded');
						if (scenario === 'shutdown-during-load') {
							worker.postMessage({ type: 'shutdown', restartNumber: 2 });
							await wait('admission-scope-disposed');
						}
						worker.postMessage({ type: 'release-admission-probe' });
						await wait('child_component_verdict');
						assert.strictEqual(messages.some(message => message.type === 'admission-components-loaded'), false);
						assert.strictEqual(messages.some(message => message.type === 'child_started'), false);
						if (!pool && scenario !== 'shutdown-during-load') {
							const socket = createConnection({ host: '127.0.0.1', port });
							try { await assert.rejects(once(socket, 'connect'), { code: 'ECONNREFUSED' }); }
							finally { socket.destroy(); }
						}
						if (scenario === 'admitted' || pool) {
							worker.postMessage({ type: 'child_admitted' });
							if (pool) await wait('admission-bind-error');
							else {
								await wait('child_started');
								await wait('admission-components-loaded');
								const socket = createConnection({ host: '127.0.0.1', port });
								let text = '';
								socket.on('data', chunk => text += chunk);
								try { await once(socket, 'end', { signal: AbortSignal.timeout(3000) }); assert.strictEqual(text, 'admitted'); }
								finally { socket.destroy(); }
							}
						}
						if (scenario !== 'shutdown-during-load') worker.postMessage({ type: 'shutdown', restartNumber: 2 });
						await waitFor(() => exited !== undefined, { timeout: 6000, message: 'Graceful exit must finish before the 10s backstop' });
						const [code] = await exit;
						assert.strictEqual(code, 0);
						assert.ok(messages.some(message => message.type === 'admission-scope-disposed'));
						if (scenario !== 'admitted') assert.strictEqual(messages.some(message => message.type === 'child_started'), false);
						if (scenario === 'refused' || scenario === 'shutdown-during-load') assert.strictEqual(messages.some(message => message.type === 'admission-components-loaded'), false);
					} finally {
						if (worker.threadId !== -1) await worker.terminate();
						if (reservation.listening) await new Promise(resolve => reservation.close(resolve));
					}
					console.log('admission boundary preserved');
				`
				);
				assert.strictEqual(output, 'admission boundary preserved', mode + ':' + scenario);
			}
		});
	}
});
