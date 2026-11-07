/**
 * Request-time CommonJS `require()` inside a component loaded by the VM module loaders follows the
 * documented `allowedDirectory: app` rule (docs/reference/components/module-loading.md:151-156):
 * a module outside the component's own directory tree is refused with
 * `Can not load module at <path> outside of allowed path <path>`, and the check resolves symlinks first.
 *
 * `cjs-require-loader.test.ts` drives one absolute outside path. This file drives the resolution shapes
 * that reach the same check by a different route, under both VM loaders: a relative sibling component,
 * an outside `.json` and `.ts`, a symlink inside the component whose realpath escapes, an outside
 * `node_modules` path, a bare specifier that resolves by climbing to `components/node_modules`, a
 * `require()` after a refused `import()` of the same file (the loader's route cache), and
 * `require.resolve()` (returns the path, loads nothing). Before #3507 (harper#2396) every one of the
 * refused legs executed the outside module.
 *
 * Oracle: `GET /Probe/` returns `{ outcome: EXECUTED | BLOCKED, sentinel?, message? }` per leg. EXECUTED
 * means the target module's body ran (its sentinel is read back); BLOCKED means `require()` threw. A
 * BLOCKED leg must also carry the documented message, so a refusal for another reason (missing file,
 * compile error) cannot read as a pass; the in-component controls prove the loader executes `.cjs`,
 * `.json` and `.ts` when the path is allowed.
 *
 * Not covered here: a sibling directory whose name shares the component's as a prefix (harper#1929),
 * and loaders obtained from `node:module` or `process.getBuiltinModule`, which the docs exclude from
 * this check (harper#2284).
 *
 * Run: npm run test:integration -- "integrationTests/components/require-confinement-parity.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

type Leg = { outcome: 'EXECUTED' | 'BLOCKED'; sentinel?: string; message?: string };
type Body = Record<string, Leg>;

const LOADERS = ['vm-current-context', 'vm'] as const;
const REFUSED_LEGS = ['rel', 'abs', 'json', 'ts', 'symlink', 'nm', 'climb'] as const;
const CONFINED = /outside of allowed path/;
const sentinel = (leg: string) => `REQUIRE_CONFINEMENT_${leg.toUpperCase()}_EXECUTED`;
const cjs = (leg: string) => `module.exports = { SENTINEL: '${sentinel(leg)}' };\n`;

async function writeFixture(dataRootDir: string): Promise<void> {
	const components = join(dataRootDir, 'components');
	const app = join(components, 'probe-app');
	const other = join(components, 'other');
	const outside = join(dataRootDir, 'outside');
	for (const d of [
		join(app, 'inside'),
		other,
		join(outside, 'node_modules', 'escape-pkg'),
		join(components, 'node_modules', 'climb-pkg'),
	]) {
		await mkdir(d, { recursive: true });
	}
	// controls, inside the component
	await writeFile(join(app, 'inside', 'secret.cjs'), cjs('control'));
	await writeFile(join(app, 'inside', 'data.json'), JSON.stringify({ SENTINEL: sentinel('controljson') }));
	await writeFile(
		join(app, 'inside', 'typed.ts'),
		`const s: string = '${sentinel('controlts')}';\nmodule.exports = { SENTINEL: s };\n`
	);
	// targets outside the component
	await writeFile(join(other, 'secret.cjs'), cjs('rel'));
	await writeFile(join(other, 'secret.json'), JSON.stringify({ SENTINEL: sentinel('json') }));
	await writeFile(
		join(other, 'secret.ts'),
		`const s: string = '${sentinel('ts')}';\nmodule.exports = { SENTINEL: s };\n`
	);
	await writeFile(join(other, 'failfirst.cjs'), cjs('failfirst'));
	await writeFile(join(other, 'dyn.cjs'), cjs('dyn'));
	await writeFile(join(outside, 'secret.cjs'), cjs('abs'));
	await writeFile(join(outside, 'secret-symlink.cjs'), cjs('symlink'));
	await writeFile(
		join(outside, 'node_modules', 'escape-pkg', 'package.json'),
		JSON.stringify({ name: 'escape-pkg', version: '1.0.0', main: 'index.js' })
	);
	await writeFile(join(outside, 'node_modules', 'escape-pkg', 'index.js'), cjs('nm'));
	await writeFile(
		join(components, 'node_modules', 'climb-pkg', 'package.json'),
		JSON.stringify({ name: 'climb-pkg', version: '1.0.0', main: 'index.js' })
	);
	await writeFile(join(components, 'node_modules', 'climb-pkg', 'index.js'), cjs('climb'));
	await symlink(outside, join(app, 'link'), 'dir');

	await writeFile(join(app, 'config.yaml'), 'jsResource:\n  files: resources.cjs\nrest: true\n');
	await writeFile(
		join(app, 'resources.cjs'),
		`const { Resource } = require('harper');
const OUTSIDE = ${JSON.stringify(outside)};
function attempt(fn) {
	try { const m = fn(); return { outcome: 'EXECUTED', sentinel: m && m.SENTINEL }; }
	catch (e) { return { outcome: 'BLOCKED', message: String(e && e.message) }; }
}
async function attemptAsync(fn) {
	try { const m = await fn(); return { outcome: 'EXECUTED', sentinel: m && (m.SENTINEL ?? (m.default && m.default.SENTINEL)) }; }
	catch (e) { return { outcome: 'BLOCKED', message: String(e && e.message) }; }
}
class Probe extends Resource {
	static loadAsInstance = false;
	static async get() {
		const out = {};
		out.control = attempt(() => require('./inside/secret.cjs'));
		out.controljson = attempt(() => require('./inside/data.json'));
		out.controlts = attempt(() => require('./inside/typed.ts'));
		out.rel = attempt(() => require('../other/secret.cjs'));
		out.abs = attempt(() => require(OUTSIDE + '/secret.cjs'));
		out.json = attempt(() => require('../other/secret.json'));
		out.ts = attempt(() => require('../other/secret.ts'));
		out.symlink = attempt(() => require('./link/secret-symlink.cjs'));
		out.nm = attempt(() => require(OUTSIDE + '/node_modules/escape-pkg/index.js'));
		out.climb = attempt(() => require('climb-pkg'));
		// import() of a file no require() leg touches: proves the import-path check is armed on its own
		out.dyn = await attemptAsync(() => import('../other/dyn.cjs'));
		// a refused import() of the file first, then require() of the same file (route cache)
		out.failfirstImport = await attemptAsync(() => import('../other/failfirst.cjs'));
		out.failfirst = attempt(() => require('../other/failfirst.cjs'));
		// require.resolve() must not throw; it returns the path and loads nothing
		out.resolve = attempt(() => ({ SENTINEL: require.resolve('../other/secret.cjs') }));
		return out;
	}
}
module.exports = { Probe };
`
	);
}

for (const loader of LOADERS) {
	suite(`require() confinement parity under moduleLoader: ${loader}`, (ctx: ContextWithHarper) => {
		let body: Body;
		const auth = () =>
			`Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		before(async () => {
			const parent = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir();
			const dataRootDir = await mkdtemp(join(parent, 'harper-integration-test-'));
			await writeFixture(dataRootDir);
			(ctx as any).harper = { dataRootDir };
			await startHarper(ctx, {
				config: {
					threads: { count: 1 },
					applications: { moduleLoader: loader },
					logging: { console: true, level: 'error', stdStreams: true },
				},
				env: {},
			});
			const deadline = Date.now() + 120_000;
			let status = 0;
			let text = '';
			while (Date.now() < deadline) {
				try {
					const res = await fetch(`${ctx.harper.httpURL}/Probe/`, {
						headers: { Authorization: auth() },
						signal: AbortSignal.timeout(5_000),
					});
					status = res.status;
					text = await res.text();
					if (status === 200) break;
				} catch {}
				await sleep(250);
			}
			assert.strictEqual(status, 200, `Probe never served under ${loader}: ${text.slice(0, 500)}`);
			body = JSON.parse(text);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test(`[${loader}] controls: in-component require() of .cjs, .json and .ts execute`, () => {
			assert.deepStrictEqual(
				[body.control, body.controljson, body.controlts].map((l) => [l.outcome, l.sentinel]),
				[
					['EXECUTED', sentinel('control')],
					['EXECUTED', sentinel('controljson')],
					['EXECUTED', sentinel('controlts')],
				]
			);
		});

		test(`[${loader}] dyn: import() of a sibling is refused by the confinement check (confinement is armed)`, () => {
			assert.strictEqual(body.dyn.outcome, 'BLOCKED', JSON.stringify(body.dyn));
			assert.match(body.dyn.message ?? '', CONFINED);
		});

		for (const leg of REFUSED_LEGS) {
			test(`[${loader}] ${leg}: require() resolving outside allowedPath is refused by the confinement check`, () => {
				assert.strictEqual(body[leg].outcome, 'BLOCKED', `${leg} EXECUTED: ${JSON.stringify(body[leg])}`);
				assert.match(body[leg].message ?? '', CONFINED, `${leg} refused for another reason: ${body[leg].message}`);
			});
		}

		test(`[${loader}] failfirst: a require() after a refused import() of the same file is refused too`, () => {
			assert.strictEqual(body.failfirstImport.outcome, 'BLOCKED', JSON.stringify(body.failfirstImport));
			assert.strictEqual(body.failfirst.outcome, 'BLOCKED', JSON.stringify(body.failfirst));
			assert.match(body.failfirst.message ?? '', CONFINED);
		});

		test(`[${loader}] resolve: require.resolve() of an outside path returns a path and runs nothing`, () => {
			assert.strictEqual(body.resolve.outcome, 'EXECUTED', JSON.stringify(body.resolve));
			assert.match(body.resolve.sentinel ?? '', /other\/secret\.cjs$/);
		});
	});
}
