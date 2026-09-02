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

	it('stages without activating in safe mode, so nothing uncertified is published', async function () {
		// Safe mode may not execute configured code, so it can certify nothing — and a candidate nothing
		// certified must not be published. It is also transient, which is why "pending" is the right answer
		// here and the wrong one for a branch-configured component: the next ordinary preparation certifies
		// and activates this.
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
				'1.0.0',
				'the live version is untouched — the candidate was staged, not activated'
			);
			assert.ok(existsSync(join(rootDir, '.deploy-staging')), 'and the staged candidate is kept for later');
		} finally {
			if (priorSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
			else process.env.HARPER_SAFE_MODE = priorSafeMode;
			await rm(rootDir, { recursive: true, force: true });
		}
	});
});
