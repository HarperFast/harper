// oxlint-disable-next-line no-restricted-imports -- repository task requires strict assertions
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');

describe('TypeStrip runtime boundaries', () => {
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
					'--input-type=module',
					'-e',
					`const { createRequire } = await import('node:module'); const require = createRequire(${JSON.stringify(helpers)}); await import(${JSON.stringify(entry)}); if (Object.keys(require.cache).map(path => path.split(require('node:path').sep).join('/')).some(path => path.includes('/alasql/') || path.includes('/mathjs/') || path.endsWith('/sqlTranslator/index.${extension}'))) throw new Error('SQL loaded during boot'); const { loadRuntimeModule } = await import(${JSON.stringify(helpers)}); const sql = loadRuntimeModule('sqlTranslator/index'); if (typeof sql.evaluateSQL !== 'function' || typeof sql.convertSQLToAST !== 'function' || typeof loadRuntimeModule('dataLayer/SQLSearch').default !== 'function' || typeof loadRuntimeModule('sqlTranslator/SelectValidator').default !== 'function') throw new Error('Cold module export missing'); console.log('cold SQL loaded'); process.exit(0);`,
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
