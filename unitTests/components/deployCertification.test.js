'use strict';

const assert = require('node:assert');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { Application, prepareApplication, markCandidateComplete } = require('#src/components/Application');
const { certifyCandidate } = require('#src/components/certifyCandidate');
const { packageDirectory } = require('#src/components/packageComponent');
const { rootApplicationLoadOptions } = require('#src/components/componentLoader');
const { getConfigObj } = require('#src/config/configUtils');

/** A component payload whose `resource.js` runs `body` when the component is loaded. */
async function payloadThatRunsOnLoad(rootDir, name, version, body) {
	const sourceDir = await mkdtemp(join(rootDir, `${name}-${version}-`));
	await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ name, version, main: 'resource.js' }));
	await writeFile(join(sourceDir, 'config.yaml'), 'jsResource:\n  files: resource.js\n');
	await writeFile(join(sourceDir, 'resource.js'), body);
	return packageDirectory(sourceDir, { skip_node_modules: true });
}

describe('deploy certification', () => {
	it('does not publish a candidate that throws at load — ON THE MAIN THREAD', async function () {
		// The whole point of this step. The in-process check this replaces was gated on `!isMainThread`, and
		// the operations API deploys on main, so this exact deploy used to succeed and publish a broken
		// component while reporting an error. Tests run on the main thread, so this is that path.
		this.timeout(30000);
		const rootDir = await mkdtemp(join(tmpdir(), 'certify-rejects-'));
		const componentDirPath = join(rootDir, 'shop');
		await mkdir(componentDirPath, { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'shop', version: '1.0.0' }));
		await writeFile(join(componentDirPath, 'index.js'), 'module.exports = { live: 1 };\n');

		const application = new Application({
			name: 'shop',
			payload: await payloadThatRunsOnLoad(rootDir, 'shop', '2.0.0', "throw new Error('candidate blew up at load');\n"),
		});
		application.dirPath = componentDirPath;

		try {
			await assert.rejects(() => prepareApplication(application), /candidate blew up at load/);
			// v1 is still the live tree, byte for byte.
			assert.strictEqual(
				JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version,
				'1.0.0',
				'the previous version still serves'
			);
			assert.strictEqual(await readFile(join(componentDirPath, 'index.js'), 'utf8'), 'module.exports = { live: 1 };\n');
			// And nothing was left claiming the rejected candidate was validated.
			assert.ok(!existsSync(join(rootDir, '.deploy-staging')), 'the rejected candidate was swept');
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('publishes a candidate that loads cleanly', async function () {
		this.timeout(30000);
		const rootDir = await mkdtemp(join(tmpdir(), 'certify-accepts-'));
		const componentDirPath = join(rootDir, 'shop');
		await mkdir(componentDirPath, { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'shop', version: '1.0.0' }));

		const application = new Application({
			name: 'shop',
			payload: await payloadThatRunsOnLoad(rootDir, 'shop', '2.0.0', 'module.exports = { fine: true };\n'),
		});
		application.dirPath = componentDirPath;

		try {
			await prepareApplication(application);
			assert.strictEqual(
				JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version,
				'2.0.0',
				'a certified candidate is published'
			);
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('publishes a static-only component, which legitimately loads no module', async function () {
		// The "loaded nothing is not a pass" guard is a net for a platform-specific no-op reading as a clean
		// verdict, and its trigger is whether the candidate declares loadable content — for which a
		// `package.json` is weak evidence, since nearly every component ships one for versioning. A component
		// of nothing but static files opens no scope and loads no module by design, so if that guard fires on
		// it, certification rejects a deploy that works today. This is the third false-rejection shape this
		// feature has produced, so it is asserted rather than assumed.
		this.timeout(30000);
		const rootDir = await mkdtemp(join(tmpdir(), 'certify-static-'));
		const componentDirPath = join(rootDir, 'brochure');
		await mkdir(componentDirPath, { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'brochure', version: '1.0.0' }));

		const sourceDir = await mkdtemp(join(rootDir, 'brochure-2.0.0-'));
		await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ name: 'brochure', version: '2.0.0' }));
		await writeFile(join(sourceDir, 'config.yaml'), "static:\n  files: 'web/**'\n");
		await mkdir(join(sourceDir, 'web'), { recursive: true });
		await writeFile(join(sourceDir, 'web', 'index.html'), '<!doctype html><title>hi</title>\n');

		const application = new Application({
			name: 'brochure',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		application.dirPath = componentDirPath;

		try {
			await prepareApplication(application);
			assert.strictEqual(
				JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version,
				'2.0.0',
				'a static-only component is published rather than rejected for loading nothing'
			);
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('rejects a candidate whose load never finishes, rather than waiting on it', async function () {
		this.timeout(30000);
		const rootDir = await mkdtemp(join(tmpdir(), 'certify-timeout-'));
		const candidateDirPath = join(rootDir, 'hangs');
		await mkdir(candidateDirPath, { recursive: true });
		await writeFile(join(candidateDirPath, 'package.json'), JSON.stringify({ name: 'hangs', version: '1.0.0' }));
		await writeFile(join(candidateDirPath, 'config.yaml'), 'jsResource:\n  files: resource.js\n');
		// Blocks the validator thread outright — `Atomics.wait` rather than a spin loop, so it holds without
		// burning CPU. The in-process check had no answer for a load that never returns: it held the
		// validation chain for the life of the process. An isolated thread can simply be given a deadline.
		await writeFile(
			join(candidateDirPath, 'resource.js'),
			'const shared = new Int32Array(new SharedArrayBuffer(4));\nAtomics.wait(shared, 0, 0);\n'
		);

		try {
			const outcome = await certifyCandidate(candidateDirPath, 'hangs', { timeoutMs: 2000 });
			assert.strictEqual(outcome.certified, false);
			assert.match(outcome.error.message, /did not finish within 2000ms/);
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('fails a deploy that cannot get a certification slot, rather than queueing it forever', async function () {
		// The concurrency cap deliberately withholds the slot of a validator that will not die, so the queue
		// behind it has to be bounded too — otherwise one stuck thread turns every later deploy into a wait
		// inside the preparation lock with nothing to report.
		this.timeout(30000);
		const rootDir = await mkdtemp(join(tmpdir(), 'certify-slots-'));
		const candidateDirPath = join(rootDir, 'hangs');
		await mkdir(candidateDirPath, { recursive: true });
		await writeFile(join(candidateDirPath, 'package.json'), JSON.stringify({ name: 'hangs', version: '1.0.0' }));
		await writeFile(join(candidateDirPath, 'config.yaml'), 'jsResource:\n  files: resource.js\n');
		await writeFile(
			join(candidateDirPath, 'resource.js'),
			'const shared = new Int32Array(new SharedArrayBuffer(4));\nAtomics.wait(shared, 0, 0);\n'
		);

		try {
			// `acquireSlot` claims synchronously when a slot is free — no await before `active++` — so both of
			// these hold slots by the time the third call runs, without sleeping to arrange it.
			const occupying = [
				certifyCandidate(candidateDirPath, 'first', { timeoutMs: 4000 }),
				certifyCandidate(candidateDirPath, 'second', { timeoutMs: 4000 }),
			];
			const queued = await certifyCandidate(candidateDirPath, 'third', { timeoutMs: 300 });
			assert.strictEqual(queued.certified, false);
			assert.match(queued.error.message, /No certification slot became available within 300ms/);
			assert.strictEqual(queued.error.statusCode, 503);
			for (const outcome of await Promise.all(occupying)) assert.strictEqual(outcome.certified, false);
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('refuses to mint .complete for a candidate no validator certified', async function () {
		// The gate itself. `.complete` is what recovery treats as proof a validation happened, so the
		// function that writes it has to require the verdict rather than trust its caller — three of
		// `prepareApplication`'s four call sites never asked for one.
		const rootDir = await mkdtemp(join(tmpdir(), 'certify-gate-'));
		const componentDirPath = join(rootDir, 'shop');
		await mkdir(join(rootDir, '.deploy-staging', 'd1', 'shop'), { recursive: true });
		try {
			await assert.rejects(
				() => markCandidateComplete(componentDirPath, 'd1', 'shop'),
				/no validator has certified it/
			);
			assert.ok(!existsSync(join(rootDir, '.deploy-staging', 'd1', '.complete')), 'and no authority was written');
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('deploys in safe mode without certifying, rather than staging a candidate nothing resumes', async function () {
		// Safe mode may not execute configured code, so it certifies nothing — and it deploys anyway, minting
		// no `.complete`.
		//
		// An earlier draft staged WITHOUT activating, reasoning that safe mode is transient so the candidate
		// could wait. Nothing resumes it: the staged tree carries no journal, so recovery removes it as build
		// residue at the next start — while the operation had already reported success, replicated, and run
		// its restart phase. An operator booting into safe mode to replace the component crashing the node
		// would have got a 200 and a node that came back running the broken component with the fix deleted.
		this.timeout(30000);
		const rootDir = await mkdtemp(join(tmpdir(), 'certify-safe-mode-'));
		const componentDirPath = join(rootDir, 'shop');
		await mkdir(componentDirPath, { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'shop', version: '1.0.0' }));

		const application = new Application({
			name: 'shop',
			payload: await payloadThatRunsOnLoad(rootDir, 'shop', '2.0.0', 'module.exports = { fine: true };\n'),
		});
		application.dirPath = componentDirPath;

		const priorSafeMode = process.env.HARPER_SAFE_MODE;
		process.env.HARPER_SAFE_MODE = '1';
		try {
			await prepareApplication(application);
			assert.strictEqual(
				JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version,
				'2.0.0',
				'the deploy takes effect — safe mode is when an operator most needs it to'
			);
		} finally {
			if (priorSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
			else process.env.HARPER_SAFE_MODE = priorSafeMode;
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	describe('branch-configured components', () => {
		// A branch's location is derived only from the application and database names, so a certification
		// load that resolved branches the way boot does would open the store the LIVE version is serving
		// from — a candidate could mutate rows, throw, be rejected, and leave the live version serving the
		// mutation. So certification never applies them, and the caller is told to skip certifying instead.
		const appName = 'branch_certify_probe';

		afterEach(() => {
			delete getConfigObj()[appName];
		});

		it('reports the component as branch-configured and withholds the branch settings', () => {
			getConfigObj()[appName] = { branchedDatabases: ['data'] };

			const forBoot = rootApplicationLoadOptions(appName);
			const forCertification = rootApplicationLoadOptions(appName, { forCertification: true });

			assert.deepStrictEqual(forBoot.options.branchedDatabases, ['data'], 'boot still gets its branches');
			assert.ok(
				!('branchedDatabases' in forCertification.options),
				'certification is never handed the live branch settings'
			);
			assert.strictEqual(forCertification.branchConfigured, true, 'and the caller is told to skip certifying');
		});

		it('still deploys a branch-configured component, it just earns no authority', async function () {
			// The half of this decision that is observable end to end: nothing is refused. That certification
			// is skipped is covered by the option test above, and that an unminted candidate rolls back
			// rather than forward is covered by the recovery suite — the composition of the two (activate,
			// mint nothing, then crash) is not covered here, and needs a crash the unit harness cannot stage.
			this.timeout(30000);
			const rootDir = await mkdtemp(join(tmpdir(), 'certify-branch-deploy-'));
			const componentDirPath = join(rootDir, appName);
			await mkdir(componentDirPath, { recursive: true });
			await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: appName, version: '1.0.0' }));
			getConfigObj()[appName] = { branchedDatabases: ['data'] };

			const application = new Application({
				name: appName,
				payload: await payloadThatRunsOnLoad(rootDir, appName, '2.0.0', 'module.exports = { fine: true };\n'),
			});
			application.dirPath = componentDirPath;

			try {
				await prepareApplication(application);
				assert.strictEqual(
					JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version,
					'2.0.0',
					'a branch-configured component still deploys — no capability is removed'
				);
			} finally {
				await rm(rootDir, { recursive: true, force: true });
			}
		});

		it('reports an ordinary component as not branch-configured', () => {
			getConfigObj()[appName] = { package: 'npm:whatever@1.0.0' };

			const forCertification = rootApplicationLoadOptions(appName, { forCertification: true });

			assert.strictEqual(forCertification.branchConfigured, false, 'so it is certified normally');
		});
	});
});
