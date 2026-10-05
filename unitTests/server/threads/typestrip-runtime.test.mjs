// oxlint-disable-next-line no-restricted-imports -- repository task requires strict assertions
import assert from 'node:assert/strict';
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
			[
				...(mode === 'typestrip' ? ['--conditions=typestrip'] : []),
				'--input-type=module',
				'-e',
				`const { createRequire } = await import('node:module');
			const require = createRequire(${JSON.stringify(pathToFileURL(resolve(root, 'package.json')).href)});
			const { materializePerPidRoot } = require(${JSON.stringify(resolve(root, 'unitTests/perPidRoot.js'))});
			process.env.ROOTPATH = materializePerPidRoot();
			console.log('fixture-root ' + process.pid);
			${code}
			process.exit(0);`,
			],
			{ env: process.env, encoding: 'utf8', timeout: 30000 }
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
	it('skips empty component configuration without reporting a load error', () => {
		for (const mode of ['compiled', 'typestrip']) {
			const prefix = mode === 'compiled' ? 'dist/' : '';
			const extension = mode === 'compiled' ? 'js' : 'ts';
			const runtimeUrl = (path) => pathToFileURL(resolve(root, `${prefix}${path}.${extension}`)).href;
			const output = runWithIsolatedRoot(
				mode,
				`
				const assert = (await import('node:assert/strict')).default;
				const { mkdirSync, writeFileSync } = await import('node:fs');
				const { join } = await import('node:path');
				const componentDirectory = join(process.env.ROOTPATH, 'empty-component');
				mkdirSync(componentDirectory); writeFileSync(join(componentDirectory,'config.yaml'),'# empty configuration\\n');
				const { loadComponent, setErrorReporter } = await import(${JSON.stringify(runtimeUrl('components/componentLoader'))});
				const { Resources } = await import(${JSON.stringify(runtimeUrl('resources/Resources'))});
				const errors = []; setErrorReporter(error => errors.push(error));
				const resources = new Resources();
				await loadComponent(componentDirectory,resources,'test-origin');
				assert.equal(errors.length, 0);
				assert.equal(resources.get(''), undefined);
				console.log('empty configuration skipped');
			`
			);
			assert.equal(output, 'empty configuration skipped', mode);
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
				const assert = (await import('node:assert/strict')).default;
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
				assert.equal((await reports).mean,7);
				setAnalyticsEnabled(false);
				const { closeLoadedDatabases } = await import(${JSON.stringify(runtimeUrl('resources/databases'))});
				await closeLoadedDatabases();
				console.log('configured analytics recorded');
			`
			);
			assert.equal(output, 'configured analytics recorded', mode);
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
				[
					...(mode === 'typestrip' ? ['--conditions=typestrip'] : []),
					'--input-type=module',
					'-e',
					`const assert = (await import('node:assert/strict')).default;
				const facade = await import(${JSON.stringify(modulePath)});
				const names = ${JSON.stringify(names)};
				assert.deepEqual(Object.keys(facade).filter(name => names.includes(name)).sort(), names.sort());
				for (const name of names) assert.equal(facade[name], globalThis[name], name);
				assert.equal(typeof facade.Resource, 'function');
				assert.equal(typeof facade.operation, 'function');
				assert.equal(typeof facade.server.http, 'function');
				assert.ok(new facade.Resource('public-facade') instanceof facade.Resource);
				console.log('public values preserved'); process.exit(0);`,
				],
				{ env: process.env, encoding: 'utf8', timeout: 30000 }
			);
			assert.equal(output.trim(), 'public values preserved', mode);
			const worker = new Worker(resolve(root, 'unitTests/bin/user-thread.js'), {
				execArgv: mode === 'typestrip' ? ['--conditions=typestrip'] : [],
				workerData: { noServerStart: true, addPorts: [], addThreadIds: [] },
			});
			try {
				for await (const [message] of on(worker, 'message', { signal: AbortSignal.timeout(30000) })) {
					if (!Object.hasOwn(message, 'hasResource')) continue;
					assert.deepEqual(message, { hasResource: true, hasServer: true }, mode);
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
				const assert = (await import('node:assert/strict')).default;
				const { Worker } = await import('node:worker_threads');
				const { once } = await import('node:events');
				const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: ${JSON.stringify(execArgv)}, workerData: { addPorts: [], addThreadIds: [] } });
				const messages = []; worker.on('message', message => messages.push(message));
				try {
					const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(10000) });
					assert.equal(code, 0);
					assert.ok(messages.some(message => message.type === 'startup-ref' && message.held === true));
					assert.ok(messages.some(message => message.type === 'startup-hook-completed'));
				} finally { if (worker.threadId !== -1) await worker.terminate(); }
				console.log('startup hook completed');`
			);
			assert.equal(output, 'startup hook completed', mode);
		}
	});

	it('passes the source condition to actual managed workers without NODE_OPTIONS', () => {
		const manager = pathToFileURL(resolve(root, 'server/threads/manageThreads.ts')).href;
		const fixture = resolve(import.meta.dirname, 'fixtures/runtime-condition.cjs');
		const output = execFileSync(
			process.execPath,
			[
				'--conditions=typestrip',
				'--input-type=module',
				'-e',
				`const { once } = await import('node:events');
				const { startWorker } = await import(${JSON.stringify(manager)});
				const worker = startWorker(${JSON.stringify(fixture)}, { name: 'runtime-condition', autoRestart: false });
				try {
					const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) });
					console.log(JSON.stringify(message));
				} finally { await worker.terminate(); }
				process.exit(0);`,
			],
			{ env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30000 }
		);
		const message = JSON.parse(output.trim());
		assert.equal(message.modulePath, resolve(root, 'server/Server.ts'));
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
					[
						...(mode === 'typestrip' ? ['--conditions=typestrip'] : []),
						'--input-type=module',
						'-e',
						`const assert = (await import('node:assert/strict')).default;
						const { readFileSync, existsSync } = await import('node:fs');
						const { createLogger, setMainLogger, loggerWithTag } = await import(${JSON.stringify(modulePath)});
						const firstPath = ${JSON.stringify(resolve(directory, mode + '-first.log'))};
						const secondPath = ${JSON.stringify(resolve(directory, mode + '-second.log'))};
						const first = createLogger({path:firstPath,level:'info',stdStreams:false});
						setMainLogger(first);
						const implicit = loggerWithTag('implicit');
						const explicit = loggerWithTag('explicit', false, first);
						const conditional = loggerWithTag('conditional', true);
						assert.equal(conditional.debug, null);
						implicit.notify('before replacement');
						setMainLogger(createLogger({path:secondPath,level:'trace',stdStreams:false}));
						implicit.notify('after replacement');
						explicit.notify('explicit remains');
						assert.equal(conditional.debug, null);
						assert.ok(existsSync(secondPath), 'implicit tag did not follow new main sink');
						assert.match(readFileSync(secondPath,'utf8'), /\\[implicit\\].*after replacement/);
						const firstText = readFileSync(firstPath,'utf8');
						assert.match(firstText, /\\[explicit\\].*explicit remains/);
						assert.doesNotMatch(firstText, /after replacement/);
						console.log('tagged logs preserved'); process.exit(0);`,
					],
					{ env: process.env, encoding: 'utf8', timeout: 30000 }
				);
				assert.equal(output.trim(), 'tagged logs preserved', mode);
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
				`const assert = (await import('node:assert/strict')).default;
					await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}launchServiceScripts/launchHarperDB.js`)).href)});
					const { hasStarted, runStartup } = await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}utility/lifecycle.${extension}`)).href)});
					assert.equal(hasStarted(), true);
					await runStartup();
					const { authentication } = await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}security/auth.${extension}`)).href)});
					const result = await authentication({headers:{asObject:{host:'example.test',cookie:'example_test-hdb-session=missing'}},ip:'203.0.113.1',method:'GET',pathname:'/',protocol:'http'}, async () => ({status:200,headers:new Headers(),body:{ok:true}}));
					assert.equal(result.status, 200);
					const { closeLoadedDatabases } = await import(${JSON.stringify(pathToFileURL(resolve(root, `${prefix}resources/databases.${extension}`)).href)});
					await closeLoadedDatabases();
					console.log('launcher initialized');`
			);
			assert.equal(output.trim(), 'launcher initialized', mode);
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
				const assert = (await import('node:assert/strict')).default;
				const { Readable } = await import('node:stream');
				const { parsePromise } = await import(${JSON.stringify(modulePath)});
				const rows = [];
				await parsePromise(Readable.from([${JSON.stringify('\uFEFFid,name\n1,first\n2,second\n')}]), (reject, result) => {
					if (result.errors.length) reject(new Error(JSON.stringify(result.errors)));
					rows.push(...result.data);
				}, value => value);
				assert.deepEqual(rows, [{ id: '1', name: 'first' }, { id: '2', name: 'second' }]);
				console.log('CSV stream parsed');`
			);
			assert.equal(output, 'CSV stream parsed', mode);
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
		assert.equal(output.trim(), 'function');
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
				assert.deepEqual(JSON.parse(output), [
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
				[
					...(mode === 'typestrip' ? ['--conditions=typestrip'] : []),
					'--input-type=module',
					'-e',
					`const { registerHooks } = await import('node:module');
					const resolutions = [];
					registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); resolutions.push(result.url); return result; } });
					await import(${JSON.stringify(entry)});
					if (resolutions.some(url => url.includes('/alasql/') || url.includes('/mathjs/') || url.endsWith('/sqlTranslator/index.${extension}'))) throw new Error('SQL loaded during boot');
					const { loadRuntimeModule } = await import(${JSON.stringify(helpers)});
					const sql = loadRuntimeModule('sqlTranslator/index');
					if (typeof sql.evaluateSQL !== 'function' || typeof sql.convertSQLToAST !== 'function' || typeof loadRuntimeModule('dataLayer/SQLSearch').default !== 'function' || typeof loadRuntimeModule('sqlTranslator/SelectValidator').default !== 'function') throw new Error('Cold module export missing');
					if (!resolutions.some(url => url.includes('/alasql/'))) throw new Error('Cold dependency observation missing');
					console.log('cold SQL loaded'); process.exit(0);`,
				],
				{ env: process.env, encoding: 'utf8', timeout: 30000 }
			);
			assert.equal(output.trim(), 'cold SQL loaded', mode);
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
			assert.equal(Object.getPrototypeOf(Source), Resource);
			assert.ok(new Derived(new Error('test')) instanceof Derived);
		}
		const output = execFileSync(
			process.execPath,
			[
				'--conditions=typestrip',
				'--input-type=module',
				'-e',
				`const { Resource } = await import(${JSON.stringify(pathToFileURL(resolve(root, 'resources/Resource.ts')).href)}); for (const [modulePath, name] of ${JSON.stringify(modules)}) { const Source = (await import(new URL(modulePath + '.ts', ${JSON.stringify(pathToFileURL(root + '/').href)})))[name]; class Derived extends Source {} if (Object.getPrototypeOf(Source) !== Resource || !(new Derived(new Error('test')) instanceof Derived)) throw new Error('Lost Resource inheritance'); } console.log('inherited'); process.exit(0);`,
			],
			{ env: process.env, encoding: 'utf8', timeout: 30000 }
		);
		assert.equal(output.trim(), 'inherited');
	});

	it('keeps worker callbacks registered before the cyclic runtime finishes loading', () => {
		const router = pathToFileURL(resolve(root, 'server/threads/socketRouter.ts')).href;
		const state = pathToFileURL(resolve(root, 'server/threads/threadMessageState.ts')).href;
		const operations = pathToFileURL(resolve(root, 'server/serverHelpers/serverUtilities.ts')).href;
		const dispatch = pathToFileURL(resolve(root, 'server/serverHelpers/operationDispatchState.ts')).href;
		const output = execFileSync(
			process.execPath,
			[
				'--conditions=typestrip',
				'--input-type=module',
				'-e',
				`const { workerHooks, listenersByType } = await import(${JSON.stringify(state)}); const schemaListener = () => {}; listenersByType.set('schema', [schemaListener]); const router = await import(${JSON.stringify(router)}); if (listenersByType.get('schema')?.[0] !== schemaListener) throw new Error('Lost event listener'); if (workerHooks.reconcile !== router.reconcileIsolatedWorkers || typeof workerHooks.monitorListener !== 'function') throw new Error('Lost startup registration'); const operations = await import(${JSON.stringify(operations)}); const { operationDispatchState } = await import(${JSON.stringify(dispatch)}); if (operationDispatchState.local?.chooseOperation !== operations.chooseOperation || operationDispatchState.local?.processLocalTransaction !== operations.processLocalTransaction) throw new Error('Lost operation dispatch'); console.log('registered'); process.exit(0);`,
			],
			{ env: process.env, encoding: 'utf8', timeout: 30000 }
		);
		assert.equal(output.trim(), 'registered');
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
			assert.equal(inherited, processIncarnation);
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
				`const { parentPort } = require('node:worker_threads'); import(${JSON.stringify(cli)}).then(cli => import(${JSON.stringify(entry)}).then(module => parentPort.postMessage({ type: 'import-complete', cli: typeof cli.harper, started: module.bootLoadsComponents() }))).catch(error => parentPort.postMessage({ type: 'import-complete', error: error.stack }));`,
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
				assert.equal(result.error, undefined, mode);
				assert.equal(result.cli, 'function', mode);
				assert.equal(result.started, false, mode);
			} finally {
				await worker.terminate();
			}
		}
	});
});
