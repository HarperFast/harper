'use strict';

// #2315 step 3: a component's root-config entry is an effect of its activation. These cover the writer every
// runtime read-modify-write of the root config document goes through — its per-effect semantics, the lock
// that serializes it with deploys, drops and `set_configuration`, and what it refuses to rewrite.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const YAML = require('yaml');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigFilePath } = require('#src/config/configUtils');
const {
	applyRootConfigEffect,
	isRootConfigEffect,
	rootConfigEffectFromDeclaration,
	withRootConfigPublicationLock,
} = require('#src/components/rootConfigPublication');
const {
	componentPreparationLockPaths,
	COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
} = require('#src/components/componentPreparationLock');
const { waitFor } = require('../waitFor.js');
const { preserveRootConfig, readRootConfig, setRootConfigEntry: writeEntry } = require('../rootConfigFixture.js');

/** Hold the publication lock until the returned release is called. Resolves once it is actually held. */
async function holdPublicationLock() {
	let release;
	let held = false;
	const holding = withRootConfigPublicationLock(
		() =>
			new Promise((resolve) => {
				held = true;
				release = resolve;
			})
	);
	await waitFor(() => held, 5000, 5);
	return async () => {
		release();
		await holding;
	};
}

describe('root config publication', () => {
	preserveRootConfig();

	describe('what each effect does to the entry', () => {
		it('sets an entry, replacing whatever the component had rather than merging into it', async () => {
			writeEntry('web', { package: 'npm:web@1', urlPath: '/old', install: { command: 'npm ci' } });

			assert.strictEqual(await applyRootConfigEffect('web', { kind: 'set', entry: { package: 'npm:web@2' } }), true);

			assert.deepStrictEqual(readRootConfig().web, { package: 'npm:web@2' }, 'a package deploy owns the whole entry');
		});

		it('adds an entry the document did not have', async () => {
			await applyRootConfigEffect('brand-new', { kind: 'set', entry: { package: 'npm:brand-new', isolated: true } });

			assert.deepStrictEqual(readRootConfig()['brand-new'], { package: 'npm:brand-new', isolated: true });
		});

		it('writes nothing when the entry already says it, so a replayed journal is a no-op', async () => {
			writeEntry('web', { package: 'npm:web@2' });
			const before = fs.statSync(getConfigFilePath());

			assert.strictEqual(await applyRootConfigEffect('web', { kind: 'set', entry: { package: 'npm:web@2' } }), false);

			const after = fs.statSync(getConfigFilePath());
			assert.strictEqual(after.ino, before.ino, 'an atomic write renames a new file in; this one was left alone');
			assert.strictEqual(after.mtimeMs, before.mtimeMs);
		});

		it("unsets only a payload deploy's registry provenance, keeping the runtime configuration it does not own", async () => {
			writeEntry('web', {
				package: 'npm:web@1',
				install: { command: 'npm ci' },
				credentials: [{ registry: 'https://registry.example', secret: 'NPM_TOKEN' }],
				isolated: true,
				urlPath: '/web',
				host: 'web.example.com',
				branchedDatabases: ['data'],
			});

			assert.strictEqual(await applyRootConfigEffect('web', { kind: 'unset-package' }), true);

			assert.deepStrictEqual(readRootConfig().web, {
				isolated: true,
				urlPath: '/web',
				host: 'web.example.com',
				branchedDatabases: ['data'],
			});
		});

		it('removes an entry that said nothing but how to install the component', async () => {
			writeEntry('web', { package: 'npm:web@1', install: { command: 'npm ci' } });

			await applyRootConfigEffect('web', { kind: 'unset-package' });

			assert.strictEqual(Object.hasOwn(readRootConfig(), 'web'), false, 'an empty entry is not left behind');
		});

		it('leaves an entry with no registry provenance, or no entry at all, exactly as it was', async () => {
			writeEntry('web', { isolated: true });

			assert.strictEqual(await applyRootConfigEffect('web', { kind: 'unset-package' }), false);
			assert.strictEqual(await applyRootConfigEffect('never-configured', { kind: 'unset-package' }), false);

			assert.deepStrictEqual(readRootConfig().web, { isolated: true });
			assert.strictEqual(Object.hasOwn(readRootConfig(), 'never-configured'), false);
		});

		it('removes the whole entry for a dropped component, and is a no-op when there is none', async () => {
			writeEntry('web', { package: 'npm:web@1', isolated: true });

			assert.strictEqual(await applyRootConfigEffect('web', { kind: 'remove' }), true);
			assert.strictEqual(await applyRootConfigEffect('web', { kind: 'remove' }), false);

			assert.strictEqual(Object.hasOwn(readRootConfig(), 'web'), false);
		});

		it('keeps the rest of the document, comments included, byte for byte outside the entry', async () => {
			const withComment =
				fs.readFileSync(getConfigFilePath(), 'utf8') + '\n# kept by the operator\nweb:\n  package: npm:web@1\n';
			fs.writeFileSync(getConfigFilePath(), withComment);

			await applyRootConfigEffect('web', { kind: 'set', entry: { package: 'npm:web@2' } });

			const written = fs.readFileSync(getConfigFilePath(), 'utf8');
			assert.match(written, /# kept by the operator/);
			assert.deepStrictEqual(
				{ ...readRootConfig(), web: undefined },
				{ ...YAML.parse(withComment), web: undefined },
				'nothing but the entry changed'
			);
		});
	});

	it('refuses to rewrite a document that does not parse, rather than writing back what the parser recovered', async () => {
		const unparseable = fs.readFileSync(getConfigFilePath(), 'utf8') + '\nweb: [unterminated\n';
		fs.writeFileSync(getConfigFilePath(), unparseable);

		await assert.rejects(
			() => applyRootConfigEffect('web', { kind: 'set', entry: { package: 'npm:web@2' } }),
			/does not parse/
		);

		assert.strictEqual(fs.readFileSync(getConfigFilePath(), 'utf8'), unparseable, 'the file is untouched');
	});

	it('does nothing at all for `keep`, not even take the lock', async () => {
		// Every boot re-install and clone prepares with `keep`; a config writer holding the lock must not delay
		// a preparation that has no config work.
		const release = await holdPublicationLock();
		try {
			assert.strictEqual(await applyRootConfigEffect('web', { kind: 'keep' }), false);
		} finally {
			await release();
		}
	});

	describe('serializes every writer of the document', () => {
		it('holds a writer until the lock is free, and then applies it', async () => {
			const release = await holdPublicationLock();
			let applied = false;
			const applying = applyRootConfigEffect('waiter', { kind: 'set', entry: { package: 'npm:waiter' } }).then(
				() => (applied = true)
			);
			try {
				// Asserting a non-event: nothing may be written while another writer holds the document.
				await sleep(300);
				assert.strictEqual(applied, false);
				assert.strictEqual(Object.hasOwn(readRootConfig(), 'waiter'), false);
			} finally {
				await release();
			}
			await applying;
			assert.deepStrictEqual(readRootConfig().waiter, { package: 'npm:waiter' });
		});

		it('loses no update when writers of different components race', async () => {
			const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

			await Promise.all(
				names.map((name) => applyRootConfigEffect(name, { kind: 'set', entry: { package: `npm:${name}` } }))
			);

			const config = readRootConfig();
			for (const name of names) assert.deepStrictEqual(config[name], { package: `npm:${name}` }, name);
		});

		it('reclaims a ticket left by a worker of this process that is gone', async () => {
			// Without worker-aware liveness a same-process ticket reads as live, and every config writer on the
			// node would time out behind it until the process restarted.
			const { lockRoot, lockName } = componentPreparationLockPaths(getConfigFilePath());
			fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
			const orphan = {
				pid: process.pid,
				threadId: 987654,
				processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
				token: 'crashed-worker',
				ticket: 1,
				purpose: 'root-config',
			};
			const orphanPath = path.join(lockRoot, `${lockName}.ticket.1.crashed-worker.json`);
			fs.writeFileSync(orphanPath, JSON.stringify(orphan));

			await applyRootConfigEffect('after-crash', { kind: 'set', entry: { package: 'npm:after-crash' } });

			assert.deepStrictEqual(readRootConfig()['after-crash'], { package: 'npm:after-crash' });
			assert.strictEqual(fs.existsSync(orphanPath), false, 'the orphaned ticket was cleared');
		});

		it('reclaims a ticket left by a process that has exited', async () => {
			const { lockRoot, lockName } = componentPreparationLockPaths(getConfigFilePath());
			fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
			const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;
			const orphanPath = path.join(lockRoot, `${lockName}.ticket.1.exited-process.json`);
			fs.writeFileSync(
				orphanPath,
				JSON.stringify({
					pid: exitedPid,
					threadId: 0,
					processInstanceId: 'an-exited-process',
					token: 'exited-process',
					ticket: 1,
				})
			);

			await applyRootConfigEffect('after-exit', { kind: 'set', entry: { package: 'npm:after-exit' } });

			assert.deepStrictEqual(readRootConfig()['after-exit'], { package: 'npm:after-exit' });
			assert.strictEqual(fs.existsSync(orphanPath), false);
		});

		it('holds set_configuration behind a deploy publishing its entry', async () => {
			const { setConfiguration } = require('#src/config/configUtils');
			const release = await holdPublicationLock();
			let answered = false;
			const setting = setConfiguration({ operation: 'set_configuration', logging_level: 'fatal' }).then(
				() => (answered = true)
			);
			try {
				await sleep(300);
				assert.strictEqual(answered, false, 'set_configuration waits for the document');
				assert.notStrictEqual(readRootConfig().logging?.level, 'fatal');
			} finally {
				await release();
			}
			await setting;
			assert.strictEqual(readRootConfig().logging?.level, 'fatal');
		});
	});
});

describe('root config effects as the journal records them', () => {
	it('declares a package build as the entry it owns, and a payload build as unsetting registry provenance', () => {
		assert.deepStrictEqual(rootConfigEffectFromDeclaration({ package: 'npm:web' }), {
			kind: 'set',
			entry: { package: 'npm:web' },
		});
		assert.deepStrictEqual(rootConfigEffectFromDeclaration(null), { kind: 'unset-package' });
	});

	it('normalizes an entry the way the journal will, so in-process and replayed effects are identical', () => {
		// An install option the caller did not set arrives as `undefined`, which JSON drops.
		const effect = rootConfigEffectFromDeclaration({
			package: 'npm:web',
			install: { command: undefined, timeout: undefined, allowInstallScripts: true },
		});

		assert.deepStrictEqual(effect.entry, { package: 'npm:web', install: { allowInstallScripts: true } });
		assert.strictEqual(Object.hasOwn(effect.entry.install, 'command'), false);
	});

	it('recognizes every effect kind and nothing else', () => {
		for (const effect of [
			{ kind: 'keep' },
			{ kind: 'set', entry: { package: 'npm:web' } },
			{ kind: 'unset-package' },
			{ kind: 'remove' },
		]) {
			assert.strictEqual(isRootConfigEffect(effect), true, JSON.stringify(effect));
		}
		for (const effect of [
			undefined,
			null,
			'set',
			[],
			{},
			{ kind: 'bogus' },
			{ kind: 'set' },
			{ kind: 'set', entry: null },
			{ kind: 'set', entry: ['npm:web'] },
		]) {
			assert.strictEqual(isRootConfigEffect(effect), false, JSON.stringify(effect));
		}
	});
});
