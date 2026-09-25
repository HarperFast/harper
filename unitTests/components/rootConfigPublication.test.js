'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const YAML = require('yaml');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigFilePath, getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const {
	applyRootConfigEffect,
	assertRootConfigEffectPublishable,
	hasRootConfigEntry,
	isRootConfigEffect,
	rootConfigEffectFromDeclaration,
	withRootConfigPublicationLock,
} = require('#src/components/rootConfigPublication');
const {
	componentPreparationLockPaths,
	COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
} = require('#src/components/componentPreparationLock');
const envModule = require('#src/utility/environment/environmentManager');
const { waitFor } = require('../waitFor.js');
const { preserveRootConfig, readRootConfig, setRootConfigEntry: writeEntry } = require('../rootConfigFixture.js');

// Root ignores the mode bits and Windows does not model them this way, so there nothing would be denied.
const permissionsEnforced = () => process.platform !== 'win32' && process.getuid?.() !== 0;

/** Run `body` with config env vars set. Nothing in it may refresh the config, or the vars would be applied for real. */
async function withConfigEnv(vars, body) {
	const saved = Object.entries(vars).map(([name]) => [name, process.env[name]]);
	Object.assign(process.env, vars);
	try {
		return await body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** Make the config refresh also run `afterRefresh`, the way an env layer rewriting the file would. */
async function withRefreshThat(afterRefresh, body) {
	const initSync = envModule.initSync;
	envModule.initSync = (force) => {
		initSync(force);
		afterRefresh();
	};
	try {
		return await body();
	} finally {
		envModule.initSync = initSync;
	}
}

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

	describe('when the root config is readable but not writable', () => {
		const modes = new Map();
		const makeReadOnly = () => {
			for (const [target, mode] of [
				[getConfigFilePath(), 0o444],
				[path.dirname(getConfigFilePath()), 0o500],
			]) {
				modes.set(target, fs.statSync(target).mode & 0o777);
				fs.chmodSync(target, mode);
			}
		};
		afterEach(() => {
			for (const [target, mode] of modes) fs.chmodSync(target, mode);
			modes.clear();
		});

		it('answers an effect the document already satisfies without the lock or write access, as every payload deploy of an unconfigured component needs', async function () {
			this.timeout(10000);
			if (!permissionsEnforced()) return this.skip();
			// Held throughout, so an answer that waited on the lock would time out rather than pass.
			const release = await holdPublicationLock();
			try {
				makeReadOnly();
				assert.strictEqual(await applyRootConfigEffect('never-configured', { kind: 'unset-package' }), false);
				assert.strictEqual(await applyRootConfigEffect('never-configured', { kind: 'remove' }), false);
				await assertRootConfigEffectPublishable('never-configured', { kind: 'unset-package' });
			} finally {
				await release();
			}
		});

		it('refuses up front an effect that would have to change the document', async function () {
			if (!permissionsEnforced()) return this.skip();
			makeReadOnly();

			await assert.rejects(
				() => assertRootConfigEffectPublishable('web', { kind: 'set', entry: { package: 'npm:web@2' } }),
				(error) => /is not writable/.test(error.message) && error.statusCode === 500
			);
			await assertRootConfigEffectPublishable('web', { kind: 'keep' });
		});
	});

	describe('serializes every writer of the document', () => {
		it("takes the lock for a satisfied effect when this thread's view of the entry is not what the file says", async function () {
			this.timeout(10000);
			// The unit harness never refreshes the memoized config from the file, so an entry written straight to
			// the file is one this thread's view does not have yet — and the refresh that fixes it can rewrite the
			// file on the main thread.
			writeEntry('configured', { package: 'npm:configured@1' });
			const release = await holdPublicationLock();
			let answered = false;
			const answering = applyRootConfigEffect('configured', {
				kind: 'set',
				entry: { package: 'npm:configured@1' },
			}).then((changed) => {
				answered = true;
				return changed;
			});
			try {
				// Asserting a non-event: it waits for the lock like any writer.
				await sleep(300);
				assert.strictEqual(answered, false);
			} finally {
				await release();
			}
			assert.strictEqual(await answering, false, 'and then changes nothing');
		});

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

describe('an effect the config environment would undo', () => {
	preserveRootConfig();

	it('is refused before anything is written when HARPER_SET_CONFIG forces another package', async () => {
		writeEntry('env-web', { package: 'npm:env-web@1' });
		const before = fs.readFileSync(getConfigFilePath(), 'utf8');
		const effect = { kind: 'set', entry: { package: 'npm:env-web@2' } };

		await withConfigEnv(
			{ HARPER_SET_CONFIG: JSON.stringify({ 'env-web': { package: 'npm:env-web@1' } }) },
			async () => {
				await assert.rejects(
					assertRootConfigEffectPublishable('env-web', effect),
					(error) => error.statusCode === 409 && /HARPER_SET_CONFIG sets env-web\.package\b/.test(error.message)
				);
				await assert.rejects(applyRootConfigEffect('env-web', effect), /HARPER_SET_CONFIG sets env-web\.package\b/);
			}
		);

		assert.strictEqual(fs.readFileSync(getConfigFilePath(), 'utf8'), before);
	});

	it('is refused the same way for HARPER_CONFIG, which reasserts its keys over edits too', async () => {
		writeEntry('env-web', { package: 'npm:env-web@1' });
		const before = fs.readFileSync(getConfigFilePath(), 'utf8');

		await withConfigEnv({ HARPER_CONFIG: JSON.stringify({ 'env-web': { package: 'npm:env-web@1' } }) }, () =>
			assert.rejects(
				applyRootConfigEffect('env-web', { kind: 'set', entry: { package: 'npm:env-web@2' } }),
				/HARPER_CONFIG sets env-web\.package\b/
			)
		);

		assert.strictEqual(fs.readFileSync(getConfigFilePath(), 'utf8'), before);
	});

	it('is refused for a payload deploy when a variable names the package it removes', async () => {
		writeEntry('env-web', { package: 'npm:env-web@1', urlPath: '/web' });

		await withConfigEnv({ HARPER_SET_CONFIG: JSON.stringify({ 'env-web': { package: 'npm:env-web@1' } }) }, () =>
			assert.rejects(
				assertRootConfigEffectPublishable('env-web', { kind: 'unset-package' }),
				/HARPER_SET_CONFIG sets env-web\.package\b.*would not last/
			)
		);
	});

	it('is refused for a drop when a variable would put the entry back', async () => {
		writeEntry('env-web', { package: 'npm:env-web@1' });

		await withConfigEnv({ HARPER_CONFIG: JSON.stringify({ 'env-web': { isolated: true } }) }, () =>
			assert.rejects(
				applyRootConfigEffect('env-web', { kind: 'remove' }),
				/HARPER_CONFIG sets env-web\.isolated\b.*would come back/
			)
		);

		assert.deepStrictEqual(readRootConfig()['env-web'], { package: 'npm:env-web@1' });
	});

	it('is not refused over a key HARPER_SET_CONFIG already sets to the declared value, whatever HARPER_CONFIG says', async () => {
		writeEntry('env-web', { package: 'npm:env-web@1' });

		await withConfigEnv(
			{
				HARPER_CONFIG: JSON.stringify({ 'env-web': { package: 'npm:env-web@1' } }),
				HARPER_SET_CONFIG: JSON.stringify({ 'env-web': { package: 'npm:env-web@2' } }),
			},
			() => assertRootConfigEffectPublishable('env-web', { kind: 'set', entry: { package: 'npm:env-web@2' } })
		);
	});

	it('is not refused over a key the variable adds beside the ones the effect declares', async () => {
		writeEntry('env-web', { package: 'npm:env-web@1', isolated: true });

		await withConfigEnv({ HARPER_SET_CONFIG: JSON.stringify({ 'env-web': { isolated: true } }) }, () =>
			assertRootConfigEffectPublishable('env-web', { kind: 'set', entry: { package: 'npm:env-web@2' } })
		);
	});

	it('throws when the config refresh leaves the file contradicting the effect', async () => {
		writeEntry('env-web', { package: 'npm:env-web@1', urlPath: '/web' });

		await withRefreshThat(
			() => writeEntry('env-web', { ...readRootConfig()['env-web'], package: 'npm:env-web@1' }),
			() =>
				assert.rejects(
					applyRootConfigEffect('env-web', { kind: 'unset-package' }),
					(error) =>
						error.statusCode === 409 &&
						/did not take effect: .* contradicts it at env-web\.package\b/.test(error.message)
				)
		);
	});
});

describe('drop_component', () => {
	preserveRootConfig();
	const dropComponent = (req) => require('#src/components/operations').dropComponent(req);
	let componentDir;

	/** A live component `name` with an entry, dropped by each test below. */
	function liveComponent(name, entry = { package: `npm:${name}`, isolated: true }) {
		componentDir = path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), name);
		fs.mkdirSync(componentDir, { recursive: true });
		fs.writeFileSync(path.join(componentDir, 'index.js'), '// live\n');
		writeEntry(name, entry);
		return entry;
	}

	afterEach(() => {
		if (!componentDir) return;
		if (fs.existsSync(componentDir)) fs.chmodSync(componentDir, 0o755);
		fs.rmSync(componentDir, { recursive: true, force: true });
		componentDir = undefined;
	});

	it('leaves the tree and its entry when the tree cannot be moved aside', async function () {
		if (!permissionsEnforced()) return this.skip();
		const entry = liveComponent('drop-stuck');
		// A directory moved under another parent must itself be writable, for its `..` entry.
		fs.chmodSync(componentDir, 0o555);

		await assert.rejects(() => dropComponent({ project: 'drop-stuck' }), /EACCES|EPERM/);

		assert.ok(fs.existsSync(path.join(componentDir, 'index.js')), 'the tree stays');
		assert.deepStrictEqual(readRootConfig()['drop-stuck'], entry, 'and so does its entry');
	});

	it('puts the tree back when its entry cannot be removed', async () => {
		const entry = liveComponent('drop-back');

		await withRefreshThat(
			() => writeEntry('drop-back', entry),
			() => assert.rejects(() => dropComponent({ project: 'drop-back' }), /did not take effect/)
		);

		assert.ok(fs.existsSync(path.join(componentDir, 'index.js')), 'the tree is back');
		assert.deepStrictEqual(readRootConfig()['drop-back'], entry);
	});

	it('finishes the drop when the refresh after the entry removal fails, rather than putting the tree back', async () => {
		liveComponent('drop-refresh');

		await withRefreshThat(
			() => {
				throw new Error('the refresh failed');
			},
			() => assert.rejects(() => dropComponent({ project: 'drop-refresh' }), /the refresh failed/)
		);

		assert.strictEqual(readRootConfig()['drop-refresh'], undefined, 'the removal was written before the refresh');
		assert.strictEqual(fs.existsSync(componentDir), false, 'so the tree is not put back without it');
	});

	it('counts the entry as still there while the document does not parse, so a failed drop keeps its tree', () => {
		fs.writeFileSync(
			getConfigFilePath(),
			fs.readFileSync(getConfigFilePath(), 'utf8') + '\nunparseable: [unterminated\n'
		);

		assert.strictEqual(hasRootConfigEntry('drop-unparseable'), true);
	});

	it('completes when the node_modules link cannot be removed, since that is cleanup after the entry', async function () {
		if (!permissionsEnforced()) return this.skip();
		liveComponent('drop-link');
		const nodeModules = path.join(envModule.get(CONFIG_PARAMS.ROOTPATH), 'node_modules');
		const link = path.join(nodeModules, 'drop-link');
		fs.mkdirSync(nodeModules, { recursive: true });
		fs.symlinkSync(componentDir, link, 'dir');
		fs.chmodSync(nodeModules, 0o555);
		try {
			await dropComponent({ project: 'drop-link' });

			assert.strictEqual(readRootConfig()['drop-link'], undefined, 'the entry is gone');
			assert.strictEqual(fs.existsSync(componentDir), false, 'and so is the tree');
		} finally {
			fs.chmodSync(nodeModules, 0o755);
			fs.rmSync(link, { force: true });
		}
	});

	it('refuses before anything moves when the entry cannot be removed', async () => {
		const componentDir = path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), 'drop-order');
		fs.mkdirSync(componentDir, { recursive: true });
		fs.writeFileSync(path.join(componentDir, 'index.js'), '// live\n');
		fs.writeFileSync(
			getConfigFilePath(),
			fs.readFileSync(getConfigFilePath(), 'utf8') + '\nunparseable: [unterminated\n'
		);
		try {
			await assert.rejects(() => dropComponent({ project: 'drop-order' }), /does not parse/);

			assert.ok(fs.existsSync(path.join(componentDir, 'index.js')), 'nothing was dropped');
		} finally {
			fs.rmSync(componentDir, { recursive: true, force: true });
		}
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
