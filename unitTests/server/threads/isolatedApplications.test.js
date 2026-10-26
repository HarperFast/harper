'use strict';
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
// Required lazily, inside the tests: loading these module graphs at file load time would install real
// loggers before sibling suites in the same mocha process (dataLoader) stub theirs.
const iso = () => require('#src/server/threads/isolatedApplications');
const application = () => require('#src/components/Application');
const http = () => require('#src/server/http');
const threads = () => require('#src/server/threads/manageThreads');
const restart = () => require('#src/bin/restart');

const CONFIG = {
	'shared': { package: 'x' },
	'iso-one': { package: 'x', isolated: true, host: 'one.qa.example' },
	'iso-two': { package: 'x', isolated: true },
	'notIsolated': { package: 'x', isolated: false },
	'http': { port: 9926 }, // a non-application entry
};

describe('isolated applications (harper#642 tier 2)', () => {
	describe('placement', () => {
		it('lists exactly the applications marked isolated', () => {
			assert.deepStrictEqual(iso().isolatedApplicationNames(CONFIG), ['iso-one', 'iso-two']);
			assert.strictEqual(iso().isIsolatedApplication('shared', CONFIG), false);
			assert.strictEqual(iso().isIsolatedApplication('http', CONFIG), false);
			assert.deepStrictEqual(iso().isolatedApplicationNames(undefined), []);
		});

		it('counts only installed isolated applications as desired capacity', () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-isolated-presence-'));
			const componentsRoot = path.join(root, 'components');
			const installedRoot = path.join(root, 'installed');
			fs.mkdirSync(path.join(componentsRoot, 'iso-one'), { recursive: true });
			try {
				assert.deepStrictEqual(
					iso().presentIsolatedApplicationNames(
						{ ...CONFIG, stale: { package: 'x', isolated: true } },
						componentsRoot,
						installedRoot,
						path.join(root, 'iso-two')
					),
					['iso-one', 'iso-two']
				);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it('a thread with no application of its own loads only the non-isolated applications', () => {
			assert.strictEqual(iso().shouldLoadApplicationHere('shared', undefined, CONFIG), true);
			assert.strictEqual(iso().shouldLoadApplicationHere('notIsolated', undefined, CONFIG), true);
			assert.strictEqual(iso().shouldLoadApplicationHere('iso-one', undefined, CONFIG), false);
			assert.strictEqual(iso().shouldLoadApplicationHere('iso-two', undefined, CONFIG), false);
		});

		it('a dedicated worker loads its own application and nothing else', () => {
			assert.strictEqual(iso().shouldLoadApplicationHere('iso-one', 'iso-one', CONFIG), true);
			assert.strictEqual(iso().shouldLoadApplicationHere('iso-two', 'iso-one', CONFIG), false);
			assert.strictEqual(
				iso().shouldLoadApplicationHere('shared', 'iso-one', CONFIG),
				false,
				'not even the shared ones'
			);
		});

		it("starts a dedicated worker's own uWS mirror but never a global port listener", () => {
			// The regression this guards: skipping every uWS entry on a dedicated worker (not just the
			// global-port ones) leaves the isolated application with no ingress at all under HARPER_UWS_UDS.
			assert.strictEqual(
				iso().shouldStartUwsListenerHere({ socketPath: '/tmp/app-iso%2Done-9926.sock' }, 'iso-one'),
				true
			);
			assert.strictEqual(iso().shouldStartUwsListenerHere({ port: 9926 }, 'iso-one'), false);
			assert.strictEqual(iso().shouldStartUwsListenerHere({ port: 9926 }, undefined), true, 'a pool worker binds it');
			assert.strictEqual(iso().shouldStartUwsListenerHere({ socketPath: '/tmp/0-9926.sock' }, undefined), true);
		});

		it('identifies only a named application owned by a dedicated worker', () => {
			assert.strictEqual(iso().thisThreadOwnsApplication('iso-one', 'iso-one'), true);
			assert.strictEqual(iso().thisThreadOwnsApplication('iso-two', 'iso-one'), false);
			assert.strictEqual(iso().thisThreadOwnsApplication(undefined, undefined), false);
		});

		it('publishes the application and its host as the route', () => {
			assert.deepStrictEqual(iso().isolatedApplicationRoute('iso-one', CONFIG), {
				application: 'iso-one',
				hosts: ['one.qa.example'],
			});
			assert.deepStrictEqual(iso().isolatedApplicationRoute('iso-two', CONFIG), { application: 'iso-two', hosts: [] });
			assert.strictEqual(iso().isolatedApplicationRoute(undefined, CONFIG), undefined);
		});

		it('refuses a dedicated worker that nothing could reach', () => {
			// this test environment configures no secure port, so a mirror would never be bound
			assert.match(String(iso().isolatedApplicationRefusal('iso-one')), /unreachable/);
		});

		it('defaults the admission budget when none is configured', () => {
			assert.strictEqual(iso().maxIsolatedApplications(), iso().DEFAULT_MAX_ISOLATED_APPLICATIONS);
		});

		it('refuses Windows where per-application UDS mirrors are unavailable', () => {
			assert.match(iso().isolatedApplicationsUnreachableReason('win32'), /Windows/);
		});

		it('counts actual dedicated applications when enforcing the admission budget', () => {
			assert.strictEqual(iso().isolatedApplicationCapacityRefusal('iso-one', ['iso-one', 'iso-two'], 2), undefined);
			assert.match(
				iso().isolatedApplicationCapacityRefusal('configured-but-not-running', ['iso-one', 'iso-two'], 2),
				/threads\.maxIsolated/
			);
		});
	});

	describe('admission to the dedicated-worker budget', () => {
		const env = () => require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const refused = (reason) => new Error(reason);
		const isolated = (...names) => Object.fromEntries(names.map((name) => [name, { package: 'x', isolated: true }]));
		// synchronous, so no other code sees these settings
		function reachable(check, max = 1) {
			const settings = [
				[CONFIG_PARAMS.HTTP_SECUREPORT, 9927],
				[CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS, true],
				[CONFIG_PARAMS.THREADS_MAXISOLATED, max],
			];
			const saved = settings.map(([key]) => [key, env().get(key)]);
			const basePath = env().getHdbBasePath();
			const mainWasWorker = threads().getWorkerIndex() === 0;
			try {
				for (const [key, value] of settings) env().setProperty(key, value);
				env().setHdbBasePath(os.tmpdir());
				threads().setMainIsWorker(false);
				assert.strictEqual(iso().isolatedApplicationRefusal('probe'), undefined);
				return check();
			} finally {
				for (const [key, value] of saved) env().setProperty(key, value);
				env().setHdbBasePath(basePath);
				threads().setMainIsWorker(mainWasWorker);
			}
		}
		before(function () {
			if (process.platform === 'win32') this.skip(); // no dedicated workers there
		});

		const admit = (...args) => reachable(() => iso().admittedIsolatedApplications(...args));
		const refusal = (candidate, running, failedClosed, config, present, max) =>
			reachable(
				() => iso().isolatedApplicationAdmissionRefusal(candidate, running, failedClosed, config, present),
				max
			);

		it('keeps running ones, then admits in config order up to the budget; a failed-closed one holds no place', () => {
			const { admitted, refused: refusals } = admit(
				['b'],
				new Map([['a', refused('its live release was refused')]]),
				['a', 'b', 'c', 'd'],
				2
			);
			assert.deepStrictEqual(admitted, ['b', 'c']);
			assert.deepStrictEqual([...refusals.keys()], ['a', 'd']);
			assert.strictEqual(refusals.get('a'), 'its live release was refused');
			assert.match(refusals.get('d'), /threads\.maxIsolated/);
		});

		it('keeps running ones and admits no new one when the refusals cannot be read', () => {
			const { admitted, refused: refusals } = admit(['b'], undefined, ['a', 'b'], 8);
			assert.deepStrictEqual(admitted, ['b']);
			assert.match(refusals.get('a'), /could not be read/);
		});

		it('admits a deploy past a first release that failed closed', () => {
			const config = isolated('broken');
			const failedClosed = new Map([['broken', refused('its canary rejected it')]]);
			assert.strictEqual(refusal('next', [], failedClosed, config, ['broken']), undefined);
			assert.match(
				String(refusal('next', [], new Map(), config, ['broken'])),
				/already runs 1 isolated application/,
				'one that may load still holds its place'
			);
		});

		it("does not hold a candidate's own refused release against it, but refuses it while the budget is full", () => {
			const failedClosed = new Map([['broken', refused('its canary rejected it')]]);
			assert.strictEqual(
				refusal('broken', [], failedClosed, isolated('broken'), ['broken']),
				undefined,
				'its fixed release replaces the refused one'
			);
			assert.match(
				String(refusal('broken', ['other'], failedClosed, isolated('broken', 'other'), ['broken', 'other'])),
				/threads\.maxIsolated/
			);
			assert.ok(failedClosed.has('broken'), 'the refusals it was given are left as they were');
		});

		it('refuses a present application that boot order would not admit (two present, budget of one)', () => {
			const config = isolated('first', 'live');
			assert.match(String(refusal('live', [], new Map(), config, ['first', 'live'])), /threads\.maxIsolated/);
			assert.strictEqual(refusal('first', [], new Map(), config, ['first', 'live']), undefined);
		});

		it('places the candidate where its root-config entry enumerates', () => {
			const config = { ...isolated('z'), flipped: { package: 'x' }, ...isolated('later') };
			assert.strictEqual(
				refusal('1', [], new Map(), config, ['z', 'later']),
				undefined,
				'a new integer-like name enumerates first, as boot will read it'
			);
			assert.match(String(refusal('new', [], new Map(), config, ['z'])), /threads\.maxIsolated/);
			const flipping = { flipped: { package: 'x' }, ...isolated('z') };
			assert.strictEqual(
				refusal('flipped', [], new Map(), flipping, ['z']),
				undefined,
				'an application turning isolated keeps its own entry, ahead of later ones'
			);
			assert.deepStrictEqual(flipping.flipped, { package: 'x' }, 'the config it was given is left as it was');
		});

		it('counts every worker still running unless its refusal withdrew its slot', () => {
			const { RejectedReleaseError } = require('#src/components/releaseCertification');
			const rejected = new RejectedReleaseError('running', 'd1', 'threw at load', true);
			const unreadable = new RejectedReleaseError('running', 'd1', 'its certification record cannot be read');
			assert.match(String(refusal('new', ['stale'], new Map(), {}, [])), /threads\.maxIsolated/, 'no longer isolated');
			assert.strictEqual(
				refusal('new', ['running'], new Map([['running', rejected]]), isolated('running'), ['running']),
				undefined
			);
			assert.match(
				String(refusal('new', ['running'], new Map([['running', unreadable]]), isolated('running'), ['running'])),
				/threads\.maxIsolated/,
				'a record that cannot be read refuses the release but stops no worker'
			);
			assert.match(
				String(refusal('new', ['turned-shared'], new Map([['turned-shared', rejected]]), {}, [])),
				/threads\.maxIsolated/,
				'main withdraws the worker only of a release that is isolated'
			);
		});

		it('refuses every candidate with a budget of zero', () => {
			assert.match(String(refusal('any', [], new Map(), {}, [], 0)), /already runs 0/);
		});
	});

	describe('socket naming', () => {
		it('is injective and filesystem-safe, and cannot collide with a pool socket', () => {
			const names = ['my-app', 'my_app', 'my app', 'my/app', 'my%app', 'app-1', 'App', '1-9926'];
			const sockets = names.map((name) => iso().applicationSocketName(name, 9926));
			assert.strictEqual(new Set(sockets).size, names.length, 'two names never share a socket');
			for (const socket of sockets) {
				assert.match(socket, /^app-[A-Za-z0-9._%-]+-9926$/, socket);
				assert.ok(!socket.includes('/'), 'never a path separator');
			}
			// a pool socket is `<index>-<port>`; an application literally named like one still cannot alias it
			assert.notStrictEqual(iso().applicationSocketName('1', 9926), '1-9926');
			assert.strictEqual(iso().applicationSocketName('my app', 9926), 'app-my%20app-9926');
			assert.ok(
				!iso().applicationSocketName('foo-bar', 9927).startsWith(iso().applicationSocketName('foo', '')),
				'application cleanup prefixes cannot match a longer name'
			);
			// fixed-width per UTF-8 byte: variable-width code-point hex would let these two collide
			assert.notStrictEqual(iso().applicationSocketName('\u01D83', 9926), iso().applicationSocketName('\u1D83', 9926));
			assert.notStrictEqual(iso().applicationSocketName('\u00E9A', 9926), iso().applicationSocketName('\u0E9A', 9926));
		});
	});

	describe('restart scope on the wire', () => {
		it('round-trips pool, one application and everything, and cannot be spoofed by an application named pool', () => {
			assert.strictEqual(
				threads().decodeRestartScope({ scope: threads().encodeRestartScope(undefined) }),
				undefined,
				'the pool'
			);
			assert.strictEqual(threads().decodeRestartScope({ scope: threads().encodeRestartScope('iso-one') }), 'iso-one');
			assert.strictEqual(
				threads().decodeRestartScope({ scope: threads().encodeRestartScope('pool') }),
				'pool',
				'a legal application name'
			);
			assert.strictEqual(
				threads().decodeRestartScope({}),
				'*',
				'a message with no scope, as every pre-existing sender, means all'
			);
		});

		it('clears the restart-required flag only from a restart that covers every worker', async () => {
			const { requestRestart, restartNeeded, resetRestartNeeded } = require('#src/components/requestRestart');
			const restartScoped = (scope) => threads().restartWorkers('http', Infinity, false, null, scope);
			// already marked shut down, so the restart loop skips it: this stands in for the live topology
			// the gate reads, not for a worker to replace. `recentELU` so the entry is complete on its own
			// rather than relying on the monitor tick to backfill it.
			const dedicated = { name: 'http', application: 'iso-one', wasShutdown: true, recentELU: { idle: 0 } };
			try {
				requestRestart();
				await restartScoped('iso-one');
				assert.strictEqual(restartNeeded(), true, 'one dedicated worker leaves the whole pool on the old code');
				await restartScoped(undefined);
				assert.strictEqual(restartNeeded(), false, 'with no dedicated worker running, the pool IS every worker');

				threads().workers.push(dedicated);
				requestRestart();
				await restartScoped(undefined);
				assert.strictEqual(restartNeeded(), true, 'a running dedicated worker keeps its old modules through it');
				await restartScoped('*');
				assert.strictEqual(restartNeeded(), false, 'only restarting every worker covers that');
			} finally {
				const at = threads().workers.indexOf(dedicated);
				if (at > -1) threads().workers.splice(at, 1);
				resetRestartNeeded();
			}
		});

		it('rejects a malformed scope before selecting workers', async () => {
			await assert.rejects(
				() => restart().restartService({ service: 'http', scope: null }),
				/Invalid HTTP worker restart scope/
			);
			await assert.rejects(
				() => restart().restartService({ service: 'http', scope: 'iso-one', scopeFallback: null }),
				/Invalid HTTP worker restart scope fallback/
			);
			await assert.rejects(
				() => restart().restartService({ service: 'http', scope: 'iso-one', scopeFallback: 'iso-two' }),
				/Invalid HTTP worker restart scope fallback/
			);
		});
	});

	describe('worker slot lifetime', () => {
		it('does not auto-restart a worker after its owner withdraws the slot lease', async () => {
			// This lifecycle-only worker must not become the process's first preload resolver: the
			// preload suite configures its fixtures later and intentionally verifies the production cache.
			const originalSafeMode = process.env.HARPER_SAFE_MODE;
			process.env.HARPER_SAFE_MODE = '1';
			let starts = 0;
			let restartChecks = 0;
			try {
				const worker = threads().startWorker(require.resolve('./fixtures/exitImmediately.cjs'), {
					onStarted: () => starts++,
					shouldAutoRestart: () => {
						restartChecks++;
						return false;
					},
				});
				await once(worker, 'exit');
				await new Promise(setImmediate);
				assert.strictEqual(restartChecks, 1);
				assert.strictEqual(starts, 1, 'the withdrawn slot did not create a replacement');
			} finally {
				if (originalSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
				else process.env.HARPER_SAFE_MODE = originalSafeMode;
			}
		});
	});

	describe('root config', () => {
		it('accepts isolated as a boolean and refuses anything else', () => {
			application().assertApplicationConfig('ok', { package: 'x', isolated: true });
			application().assertApplicationConfig('ok', { package: 'x', isolated: false });
			application().assertApplicationConfig('ok', { package: 'x' });
			assert.throws(
				() => application().assertApplicationConfig('bad', { package: 'x', isolated: 'yes' }),
				/Invalid 'isolated'/
			);
		});
	});

	describe('mirror metadata', () => {
		const dir = path.join(testUtils.ENV_DIR_PATH, 'sockets');
		const secureServer = { secureContexts: new Map() };
		before(() => fs.mkdirSync(dir, { recursive: true }));

		it('names the application and its hosts, separately from certificate coverage', () => {
			const yamlPath = path.join(dir, 'app-iso-9926.yaml');
			http().writeUdsMetadata(yamlPath, 9926, secureServer, undefined, true, {
				application: 'iso one',
				hosts: ['one.qa.example', 'alt.qa.example'],
			});
			const yaml = fs.readFileSync(yamlPath, 'utf8');
			assert.match(yaml, /^application: "iso one"$/m);
			assert.match(yaml, /^applicationHosts:\n {2}- "one\.qa\.example"\n {2}- "alt\.qa\.example"$/m);
			assert.match(yaml, /^certificates:$/m, 'certificate coverage is still published');
		});

		it('publishes an empty host list as a list, not as nothing', () => {
			const yamlPath = path.join(dir, 'app-nohost-9926.yaml');
			http().writeUdsMetadata(yamlPath, 9926, secureServer, undefined, true, { application: 'nohost', hosts: [] });
			assert.match(fs.readFileSync(yamlPath, 'utf8'), /^applicationHosts: \[\]$/m);
		});

		it('publishes no route for a pool worker', () => {
			const yamlPath = path.join(dir, '0-9926.yaml');
			http().writeUdsMetadata(yamlPath, 9926, secureServer, undefined, true, undefined);
			const yaml = fs.readFileSync(yamlPath, 'utf8');
			assert.doesNotMatch(yaml, /application/);
		});
	});
});
