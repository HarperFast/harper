'use strict';
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// Required lazily, inside the tests: loading these module graphs at file load time would install real
// loggers before sibling suites in the same mocha process (dataLoader) stub theirs.
const iso = () => require('#src/server/threads/isolatedApplications');
const application = () => require('#src/components/Application');
const http = () => require('#src/server/http');
const threads = () => require('#src/server/threads/manageThreads');

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
			assert.strictEqual(iso().isolatedWorkerHeapShareCount(2, 8), 10);
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
