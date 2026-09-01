'use strict';

// Hot reload of the `models:` config block (#2344): changed entries are rebuilt through the same
// factories boot uses and swapped in atomically, removed entries stop serving, application
// overrides keep their precedence, and a file rewrite reaches live requests with no restart.

const assert = require('node:assert');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { stringify } = require('yaml');
const { waitFor } = require('../../waitFor.js');
const { getSharedRootConfigWatcher } = require('#src/config/RootConfigWatcher');
const {
	bootstrapModels,
	applyModelsConfig,
	startModelsConfigHotReload,
	stopModelsConfigHotReload,
	resetModelsProjection,
} = require('#src/resources/models/bootstrap');
const {
	clearRegistry,
	getBackend,
	setEmbedding,
	resolveEmbedding,
	ModelBackendNotFoundError,
} = require('#src/resources/models/backendRegistry');
const { getRouter, clearRouting } = require('#src/resources/models/routing');

// Captures the Authorization header a real embed call sends. The backend takes `globalThis.fetch`
// at construction time, so this must be installed before the backend under test is built.
function installFetchCapture() {
	const sent = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		sent.push(init?.headers?.Authorization);
		return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
	return {
		sent,
		restore() {
			globalThis.fetch = original;
		},
	};
}

const openaiEntry = (apiKey, extra = {}) => ({ backend: 'openai', model: 'text-embedding-3-small', apiKey, ...extra });
const block = (entries) => ({ embedding: entries });

describe('models config hot reload (#2344)', () => {
	beforeEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	afterEach(() => {
		stopModelsConfigHotReload();
	});

	describe('applyModelsConfig', () => {
		it('serves later requests with the rewritten credential, through the normal resolution path', async () => {
			const captured = installFetchCapture();
			try {
				await bootstrapModels({ models: block({ default: openaiEntry('sk-first') }) });
				await resolveEmbedding('default').embed('hello', { model: 'text-embedding-3-small' });
				assert.equal(captured.sent.at(-1), 'Bearer sk-first');

				await applyModelsConfig(block({ default: openaiEntry('sk-second') }));

				// Resolved the same way a request resolves it — no restart, no caller re-registration.
				await resolveEmbedding('default').embed('hello', { model: 'text-embedding-3-small' });
				assert.equal(captured.sent.at(-1), 'Bearer sk-second', 'the new credential reaches the provider');
			} finally {
				captured.restore();
			}
		});

		it('does not reconstruct an unchanged entry', async () => {
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1'), other: openaiEntry('sk-2') }) });
			const defaultBefore = getBackend('embedding', 'default');
			const otherBefore = getBackend('embedding', 'other');

			await applyModelsConfig(block({ default: openaiEntry('sk-1'), other: openaiEntry('sk-2b') }));

			assert.equal(getBackend('embedding', 'default'), defaultBefore, 'unchanged entry keeps its instance');
			assert.notEqual(getBackend('embedding', 'other'), otherBefore, 'changed entry was rebuilt');
		});

		it('stops serving an entry removed from the block, leaving the others alone', async () => {
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1'), retired: openaiEntry('sk-2') }) });
			const defaultBefore = getBackend('embedding', 'default');

			await applyModelsConfig(block({ default: openaiEntry('sk-1') }));

			assert.throws(() => resolveEmbedding('retired'), ModelBackendNotFoundError);
			assert.equal(getBackend('embedding', 'default'), defaultBefore);
		});

		it('leaves an application override in place on reload AND on removal', async () => {
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });
			const appOwned = { name: 'app-policy-backend', capabilities: () => ({ embed: true }) };
			setEmbedding('default', appOwned);

			await applyModelsConfig(block({ default: openaiEntry('sk-2') }));
			assert.equal(getBackend('embedding', 'default'), appOwned, 'reload must not clobber the override');

			await applyModelsConfig(block({}));
			assert.equal(getBackend('embedding', 'default'), appOwned, 'removal must not delete the override');
		});

		it("publishes a factory's helper registration with its primary, not mid-construction", async () => {
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			let release;
			let applying;
			globalThis.__helperGate = new Promise((resolve) => (release = resolve));
			globalThis.__helperGateReached = false;
			try {
				applying = bootstrapModels({ models: block({ default: { backend: helperModule, model: 'm1' } }) });
				await waitFor(() => globalThis.__helperGateReached, { message: 'construction never started' });

				// Mid-construction: neither the helper nor the primary may be visible yet.
				assert.equal(getBackend('embedding', 'default-helper'), undefined, 'helper must not publish early');
				assert.equal(getBackend('embedding', 'default'), undefined);

				release();
				await applying;
				assert.ok(getBackend('embedding', 'default'), 'primary published');
				assert.ok(getBackend('embedding', 'default-helper'), 'helper published with it');
			} finally {
				// A thrown assertion above must not leave the apply chain parked on the gate — every
				// later test's applies queue behind it and the whole suite hangs.
				release();
				await applying?.catch(() => {});
				delete globalThis.__helperGate;
				delete globalThis.__helperGateReached;
			}
		});

		it('removes a helper together with its removed entry on re-bootstrap; reload refuses both', async () => {
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			await bootstrapModels({ models: block({ default: { backend: helperModule, model: 'm1' } }) });
			const entry = getBackend('embedding', 'default');
			assert.ok(getBackend('embedding', 'default-helper'), 'helper installed with its entry');

			// Reload: module entries are restart-managed in both directions.
			await applyModelsConfig(block({}));
			assert.equal(getBackend('embedding', 'default'), entry, 'reload keeps the module entry');
			assert.ok(getBackend('embedding', 'default-helper'), 'and its helper');

			// Re-bootstrap (the restart-shaped event): removal takes effect, helper cascades.
			await bootstrapModels({ models: block({}) });
			assert.equal(getBackend('embedding', 'default'), undefined);
			assert.equal(getBackend('embedding', 'default-helper'), undefined, 'helper removed with its entry');
		});

		it('removes a stale helper when a re-bootstrap registers a different one', async () => {
			// Module factories run only at boot now, so helper rotation is a restart-shaped event.
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			await bootstrapModels({
				models: block({ default: { backend: helperModule, model: 'm1', helperName: 'helper-a' } }),
			});
			assert.ok(getBackend('embedding', 'helper-a'));

			await bootstrapModels({
				models: block({ default: { backend: helperModule, model: 'm2', helperName: 'helper-b' } }),
			});

			assert.equal(getBackend('embedding', 'helper-a'), undefined, 'stale helper removed');
			assert.ok(getBackend('embedding', 'helper-b'), 'replacement helper installed');
		});

		it('a module entry rename on reload keeps the old name serving instead of half-applying', async () => {
			// Refusing the added name while removing the old one would turn a rename into a bare
			// removal; module entries are restart-managed in both directions.
			const counting = join(__dirname, 'fixtures', 'counting-backend-module.cjs');
			await bootstrapModels({ models: block({ old: { backend: counting, model: 'm1' } }) });
			const before = getBackend('embedding', 'old');

			await applyModelsConfig(block({ renamed: { backend: counting, model: 'm1' } }));

			assert.equal(getBackend('embedding', 'old'), before, 'old name keeps serving');
			assert.equal(getBackend('embedding', 'renamed'), undefined, 'new name waits for a restart');
		});

		it('refuses to run a module factory on reload, retaining the previous projection', async () => {
			// A module factory may compose with other entries; staged reload construction cannot
			// honor that ordering, so changing one keeps restart semantics (review decision).
			const counting = join(__dirname, 'fixtures', 'counting-backend-module.cjs');
			globalThis.__countingBackendBuilds = 0;
			try {
				await bootstrapModels({ models: block({ default: { backend: counting, model: 'm1' } }) });
				const before = getBackend('embedding', 'default');
				assert.equal(globalThis.__countingBackendBuilds, 1);

				await applyModelsConfig(block({ default: { backend: counting, model: 'm2' } }));

				assert.equal(globalThis.__countingBackendBuilds, 1, 'factory not re-run on reload');
				assert.equal(getBackend('embedding', 'default'), before, 'previous backend retained');
			} finally {
				delete globalThis.__countingBackendBuilds;
			}
		});

		it('boot installs entries sequentially, so a later module factory can wrap an earlier one', async () => {
			// The order-dependent composition boot has always allowed: `cached` resolves `base` at
			// factory time. Staged boot construction broke this (review finding); per-entry publish
			// restores it.
			const wrapping = join(__dirname, 'fixtures', 'wrapping-backend-module.cjs');
			globalThis.__wrapperSawBase = undefined;
			try {
				await bootstrapModels({
					models: block({
						base: openaiEntry('sk-base'),
						cached: { backend: wrapping, wraps: 'base' },
					}),
				});

				assert.equal(globalThis.__wrapperSawBase, true, 'the wrapper factory saw its base installed');
				assert.ok(getBackend('embedding', 'cached'));
			} finally {
				delete globalThis.__wrapperSawBase;
			}
		});

		it('does not clobber an application override of a helper name', async () => {
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			await bootstrapModels({ models: block({ default: { backend: helperModule, model: 'm1' } }) });
			const appOwned = { name: 'app-helper', capabilities: () => ({ embed: true }) };
			setEmbedding('default-helper', appOwned);

			await applyModelsConfig(block({ default: { backend: helperModule, model: 'm2' } }));

			assert.equal(getBackend('embedding', 'default-helper'), appOwned, 'helper override survives the rebuild');
			assert.ok(getBackend('embedding', 'default'), 'the primary itself still rotated');
		});

		it('treats a snapshot with no models key as a no-op, not a total removal', async () => {
			// A non-atomic in-place rewrite can be observed as a valid YAML prefix that has not reached
			// the models block yet; adopting that as authoritative would remove every backend.
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });
			const before = getBackend('embedding', 'default');

			await applyModelsConfig(undefined);

			assert.equal(getBackend('embedding', 'default'), before, 'projection untouched');
		});

		it('rejects a reload the boot schema would reject, keeping the previous projection', async () => {
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });
			const before = getBackend('embedding', 'default');

			// Boot would refuse both of these in configValidator; a hot reload must not be laxer.
			await applyModelsConfig(block({ default: openaiEntry('sk-2', { requestTimeoutMs: -1 }) }));
			assert.equal(getBackend('embedding', 'default'), before, 'invalid field value rejected');

			await applyModelsConfig(block({ default: { backend: 'openai', apiKey: 'sk-2', baseUrI: 'typo' } }));
			assert.equal(getBackend('embedding', 'default'), before, 'unknown field name rejected');
		});

		it('rejects models: null on reload exactly as boot validation would, and {} is the clear', async () => {
			// Boot's validator refuses `models: null`, so accepting it live would leave a file on disk
			// that the next restart rejects. The sole off-switch is an empty (or shrunken) block.
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });
			const before = getBackend('embedding', 'default');

			await applyModelsConfig(null);
			assert.equal(getBackend('embedding', 'default'), before, 'null rejected, prior projection kept');

			await applyModelsConfig({ embedding: {} });
			assert.equal(getBackend('embedding', 'default'), undefined, 'an explicit empty block clears');
		});

		it('tolerates a boot-legal sibling key next to embedding/generative on reload', async () => {
			// Boot validates with allowUnknown, so `models.debug: true` boots; a reload rejecting it
			// would silently block every future rotation in that file. The capture must precede the
			// apply — the backend takes globalThis.fetch at construction.
			const captured = installFetchCapture();
			try {
				await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });

				await applyModelsConfig({ ...block({ default: openaiEntry('sk-2') }), debug: true });

				await resolveEmbedding('default').embed('x', { model: 'text-embedding-3-small' });
				assert.equal(captured.sent.at(-1), 'Bearer sk-2', 'the rotation applied despite the sibling key');
			} finally {
				captured.restore();
			}
		});

		it('restores a suppressed helper the moment its claiming entry is removed', async () => {
			// Boot with a factory helper AND a config entry of the same name: the entry wins, the
			// helper's record is suppressed rather than forgotten, and dropping the entry restores the
			// helper — the live registry matches a restart with the same final config.
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			await bootstrapModels({
				models: block({
					'default': { backend: helperModule, model: 'm1' },
					'default-helper': openaiEntry('sk-own'),
				}),
			});
			const winner = getBackend('embedding', 'default-helper');
			assert.ok(winner && winner.name !== 'helper', 'the config entry owns the name at boot');

			await applyModelsConfig(block({ default: { backend: helperModule, model: 'm1' } }));

			const restored = getBackend('embedding', 'default-helper');
			assert.ok(restored, 'the helper is back the moment the claiming entry is removed');
			assert.notEqual(restored, winner, 'and it is the factory helper, not the removed entry');
		});

		it('lets a config entry claim a name held by a projection-installed helper', async () => {
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			await bootstrapModels({ models: block({ default: { backend: helperModule, model: 'm1' } }) });
			const helperInstance = getBackend('embedding', 'default-helper');
			assert.ok(helperInstance);

			// Config outranks the projection's own helpers — but never an application override.
			await applyModelsConfig(
				block({ 'default': { backend: helperModule, model: 'm1' }, 'default-helper': openaiEntry('sk-own') })
			);

			const claimed = getBackend('embedding', 'default-helper');
			assert.ok(claimed && claimed !== helperInstance, 'the config entry now owns the name');

			// The parent no longer tracks it: removing the parent must not remove the claimed entry.
			await applyModelsConfig(block({ 'default-helper': openaiEntry('sk-own') }));
			assert.equal(getBackend('embedding', 'default-helper'), claimed);
		});

		it('a module entry change under an override is refused, leaving override and helper intact', async () => {
			// Module factories no longer run on reload, so nothing rotates here by design; the refusal
			// must leave every installed piece exactly as it was.
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			await bootstrapModels({
				models: block({ default: { backend: helperModule, model: 'm1', helperName: 'helper-a' } }),
			});
			const helperA = getBackend('embedding', 'helper-a');
			const appOwned = { name: 'app-policy-backend', capabilities: () => ({ embed: true }) };
			setEmbedding('default', appOwned);

			await applyModelsConfig(block({ default: { backend: helperModule, model: 'm2', helperName: 'helper-b' } }));

			assert.equal(getBackend('embedding', 'default'), appOwned, 'primary override intact');
			assert.equal(getBackend('embedding', 'helper-a'), helperA, 'existing helper untouched');
			assert.equal(getBackend('embedding', 'helper-b'), undefined, 'no factory ran on reload');
		});

		it('a failed rebuild keeps the routing that was applied with the serving backend', async () => {
			await bootstrapModels({
				models: block({
					default: openaiEntry('sk-1', { fallback: ['safe'] }),
					safe: openaiEntry('sk-s'),
					other: openaiEntry('sk-o'),
				}),
			});
			const before = getBackend('embedding', 'default');

			// Schema-valid but unbuildable (module cannot be imported), with a re-pointed fallback: the
			// old backend keeps serving, so it keeps the routing it was applied with.
			await applyModelsConfig(
				block({
					default: { backend: './nonexistent-backend.cjs', fallback: ['other'] },
					safe: openaiEntry('sk-s'),
					other: openaiEntry('sk-o'),
				})
			);

			assert.equal(getBackend('embedding', 'default'), before, 'previous backend retained');
			const candidates = getRouter().route({ kind: 'embedding', logicalName: 'default', requires: [] });
			assert.strictEqual(candidates.length, 2);
			assert.strictEqual(candidates[1], getBackend('embedding', 'safe'), 'old fallback retained, not the new one');
		});

		it('a re-bootstrap with a shrunk config removes entries the new config dropped', async () => {
			// A long-lived process can re-run boot (a component reload cycle); the projection survives
			// bootstrapModels, so absence stays authoritative there too.
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1'), extra: openaiEntry('sk-2') }) });
			assert.ok(getBackend('embedding', 'extra'));

			await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });

			assert.equal(getBackend('embedding', 'extra'), undefined, 'dropped entry removed on re-boot');
			assert.ok(getBackend('embedding', 'default'), 'kept entry still serves');
		});

		it('keeps config-defined fallback routing when an override owns a now-malformed entry', async () => {
			await bootstrapModels({
				models: block({ default: openaiEntry('sk-1', { fallback: ['alt'] }), alt: openaiEntry('sk-alt') }),
			});
			const appOwned = {
				name: 'app-policy-backend',
				capabilities: () => ({ embed: true }),
				embed: async () => ({ status: 'completed', output: [Float32Array.from([1])] }),
			};
			setEmbedding('default', appOwned);

			await applyModelsConfig(block({ default: { backend: '' }, alt: openaiEntry('sk-alt') }));

			const candidates = getRouter().route({ kind: 'embedding', logicalName: 'default', requires: [] });
			assert.strictEqual(candidates[0], appOwned, 'the override serves');
			assert.strictEqual(candidates.length, 2, 'and keeps its config-defined fallback');
		});

		it('does not rebuild an overridden entry on every unrelated reload', async () => {
			const countingModule = join(__dirname, 'fixtures', 'counting-backend-module.cjs');
			const countingEntry = { backend: countingModule, model: 'm1' };
			globalThis.__countingBackendBuilds = 0;
			try {
				await bootstrapModels({ models: block({ default: countingEntry }) });
				assert.equal(globalThis.__countingBackendBuilds, 1);

				const appOwned = { name: 'app-policy-backend', capabilities: () => ({ embed: true }) };
				setEmbedding('default', appOwned);

				// An UNCHANGED entry under an override must not rebuild at all — any occupant satisfies a
				// reload's unchanged-skip.
				const buildsBeforeUnchanged = globalThis.__countingBackendBuilds;
				await applyModelsConfig(block({ default: countingEntry }));
				assert.equal(globalThis.__countingBackendBuilds, buildsBeforeUnchanged, 'no rebuild when unchanged');

				// A change under an override loses the swap once (and records that), then unchanged
				// reloads stop reconstructing.
				await applyModelsConfig(block({ default: { ...countingEntry, model: 'm2' } }));
				const buildsAfterChange = globalThis.__countingBackendBuilds;
				await applyModelsConfig(block({ default: { ...countingEntry, model: 'm2' } }));
				await applyModelsConfig(block({ default: { ...countingEntry, model: 'm2' } }));

				assert.equal(globalThis.__countingBackendBuilds, buildsAfterChange, 'no rebuild on unchanged reloads');
				assert.equal(getBackend('embedding', 'default'), appOwned, 'override still in place');
			} finally {
				delete globalThis.__countingBackendBuilds;
			}
		});

		it('keeps the previous backend and its fallback routing when a rebuild fails', async () => {
			await bootstrapModels({
				models: block({
					default: openaiEntry('sk-1', { fallback: ['alt'] }),
					alt: openaiEntry('sk-alt'),
				}),
			});
			const before = getBackend('embedding', 'default');

			// apiKey removed → openai's constructor rejects → the old entry must keep serving.
			await applyModelsConfig(
				block({ default: openaiEntry(undefined, { fallback: ['alt'] }), alt: openaiEntry('sk-alt') })
			);

			assert.equal(getBackend('embedding', 'default'), before, 'previous backend retained');
			const candidates = getRouter().route({ kind: 'embedding', logicalName: 'default', requires: [] });
			assert.strictEqual(candidates.length, 2, 'fallback routing survives a failed rebuild of a still-serving entry');
			assert.strictEqual(candidates[0], before);
			assert.strictEqual(candidates[1], getBackend('embedding', 'alt'));
		});

		it('updates fallback routing with the block', async () => {
			await bootstrapModels({
				models: block({
					default: openaiEntry('sk-1', { fallback: ['a'] }),
					a: openaiEntry('sk-a'),
					b: openaiEntry('sk-b'),
				}),
			});

			await applyModelsConfig(
				block({ default: openaiEntry('sk-1', { fallback: ['b'] }), a: openaiEntry('sk-a'), b: openaiEntry('sk-b') })
			);

			const candidates = getRouter().route({ kind: 'embedding', logicalName: 'default', requires: [] });
			assert.strictEqual(candidates.length, 2);
			assert.strictEqual(candidates[0], getBackend('embedding', 'default'));
			assert.strictEqual(candidates[1], getBackend('embedding', 'b'), 'the group now routes to b, not a');
		});

		it('keeps boot semantics when a reload coalesces over a queued boot', async () => {
			// While an apply is in flight, a queued bootstrapModels can be overwritten by a watcher
			// event; the newest block wins, but the boot flag must stick or the re-bootstrap silently
			// loses its overwrite contract.
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			const appOwned = { name: 'app-policy-backend', capabilities: () => ({ embed: true }) };
			let release;
			let inFlight;
			globalThis.__helperGate = new Promise((resolve) => (release = resolve));
			globalThis.__helperGateReached = false;
			try {
				setEmbedding('victim', appOwned);
				inFlight = bootstrapModels({ models: block({ slow: { backend: helperModule, model: 'm1' } }) });
				await waitFor(() => globalThis.__helperGateReached, { message: 'in-flight apply never started' });

				const boot = bootstrapModels({ models: block({ victim: openaiEntry('sk-boot') }) });
				const reload = applyModelsConfig(block({ victim: openaiEntry('sk-boot') }));

				release();
				await Promise.all([inFlight, boot, reload]);

				assert.notEqual(getBackend('embedding', 'victim'), appOwned, 'boot overwrote the occupant');
			} finally {
				release();
				await inFlight?.catch(() => {});
				delete globalThis.__helperGate;
				delete globalThis.__helperGateReached;
			}
		});

		it('a boot supersedes a reload queued before it, and is refined by one queued after', async () => {
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			let release;
			let inFlight;
			globalThis.__helperGate = new Promise((resolve) => (release = resolve));
			globalThis.__helperGateReached = false;
			try {
				inFlight = bootstrapModels({ models: block({ slow: { backend: helperModule, model: 'm1' } }) });
				await waitFor(() => globalThis.__helperGateReached, { message: 'in-flight apply never started' });

				// Queued in this order: stale reload, then a NEWER boot. Draining the stale reload after
				// the boot would resurrect `stale` and refine the newer truth backwards.
				const staleReload = applyModelsConfig(
					block({ slow: { backend: helperModule, model: 'm1' }, stale: openaiEntry('sk-stale') })
				);
				const boot = bootstrapModels({
					models: block({ slow: { backend: helperModule, model: 'm1' }, keeper: openaiEntry('sk-boot') }),
				});

				release();
				await Promise.all([inFlight, staleReload, boot]);

				assert.ok(getBackend('embedding', 'keeper'), 'the boot applied');
				assert.equal(getBackend('embedding', 'stale'), undefined, 'the older reload was discarded');

				// And the other half of the contract: a reload queued AFTER the boot still refines it.
				await applyModelsConfig(
					block({
						slow: { backend: helperModule, model: 'm1' },
						keeper: openaiEntry('sk-boot'),
						late: openaiEntry('sk-late'),
					})
				);
				assert.ok(getBackend('embedding', 'late'), 'a post-boot reload applied its distinct state');
			} finally {
				release();
				await inFlight?.catch(() => {});
				delete globalThis.__helperGate;
				delete globalThis.__helperGateReached;
			}
		});

		it('a watcher block coalescing over a queued boot is NOT laundered through boot semantics', async () => {
			// The two lanes must stay separate: boot applies its own block with overwrite authority, and
			// the newer reload block still faces reload validation and the missing-key no-op — a sticky
			// flag merging them would let a partial-write prefix tear everything down as "boot".
			const helperModule = join(__dirname, 'fixtures', 'helper-backend-module.cjs');
			let release;
			let inFlight;
			globalThis.__helperGate = new Promise((resolve) => (release = resolve));
			globalThis.__helperGateReached = false;
			try {
				inFlight = bootstrapModels({ models: block({ slow: { backend: helperModule, model: 'm1' } }) });
				await waitFor(() => globalThis.__helperGateReached, { message: 'in-flight apply never started' });

				// Boot's block is authoritative for the whole map, so it must carry `slow` itself —
				// what's under test is the reload lane, not boot's removal semantics.
				const boot = bootstrapModels({
					models: block({ keeper: openaiEntry('sk-boot'), slow: { backend: helperModule, model: 'm1' } }),
				});
				// A raw watcher snapshot with no models key lands on top of the queued boot.
				const reload = applyModelsConfig(undefined);

				release();
				await Promise.all([inFlight, boot, reload]);

				assert.ok(getBackend('embedding', 'keeper'), 'boot applied its own block');
				// The missing-key snapshot was a no-op, not a boot-authority removal of everything.
				assert.ok(getBackend('embedding', 'slow'), 'the missing-key reload removed nothing');
			} finally {
				release();
				await inFlight?.catch(() => {});
				delete globalThis.__helperGate;
				delete globalThis.__helperGateReached;
			}
		});

		it('coalesces rapid applies to the latest block', async () => {
			const captured = installFetchCapture();
			try {
				await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });

				const first = applyModelsConfig(block({ default: openaiEntry('sk-2') }));
				const second = applyModelsConfig(block({ default: openaiEntry('sk-3') }));
				await Promise.all([first, second]);

				await resolveEmbedding('default').embed('x', { model: 'text-embedding-3-small' });
				assert.equal(captured.sent.at(-1), 'Bearer sk-3', 'the newest queued block is what applied');
			} finally {
				captured.restore();
			}
		});

		it('rejects a block with a malformed entry wholesale, retaining backends AND routing', async () => {
			// Schema validation front-runs per-entry handling on reload: one malformed entry rejects the
			// snapshot, so nothing is removed and routing is untouched — a broken rewrite cannot
			// half-apply.
			await bootstrapModels({
				models: block({ default: openaiEntry('sk-1', { fallback: ['alt'] }), alt: openaiEntry('sk-alt') }),
			});
			const before = getBackend('embedding', 'default');

			await applyModelsConfig(block({ default: { backend: '' }, alt: openaiEntry('sk-alt') }));

			assert.equal(getBackend('embedding', 'default'), before, 'nothing removed');
			assert.ok(getBackend('embedding', 'alt'), 'sibling untouched');
			const candidates = getRouter().route({ kind: 'embedding', logicalName: 'default', requires: [] });
			assert.strictEqual(candidates.length, 2, 'routing untouched');
			assert.strictEqual(candidates[0], before);
		});

		it('removes true absence through a valid block', async () => {
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1'), retired: openaiEntry('sk-2') }) });

			await applyModelsConfig(block({ default: openaiEntry('sk-1') }));

			assert.throws(() => resolveEmbedding('retired'), ModelBackendNotFoundError);
			assert.ok(getBackend('embedding', 'default'), 'kept entry still serves');
		});

		it('survives a poisoned block and still applies the next one', async () => {
			await bootstrapModels({ models: block({ default: openaiEntry('sk-1') }) });
			const poisoned = {};
			Object.defineProperty(poisoned, 'embedding', {
				enumerable: true,
				get() {
					throw new Error('poisoned block');
				},
			});

			// Must resolve, not reject: the watcher calls fire-and-forget, so a rejection here would be
			// an unhandled rejection in production.
			await applyModelsConfig(poisoned);

			const rotated = block({ default: openaiEntry('sk-after-poison') });
			await applyModelsConfig(rotated);
			assert.notEqual(getBackend('embedding', 'default'), undefined, 'later applies still work');
		});
	});

	describe('startModelsConfigHotReload', () => {
		const ENV_LAYERS = ['HARPER_SET_CONFIG', 'HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG'];
		let savedEnv;

		beforeEach(() => {
			savedEnv = {};
			for (const name of ENV_LAYERS) {
				savedEnv[name] = process.env[name];
				delete process.env[name];
			}
		});

		afterEach(() => {
			for (const name of ENV_LAYERS) {
				if (savedEnv[name] === undefined) delete process.env[name];
				else process.env[name] = savedEnv[name];
			}
		});

		it('stays off when an env layer names models through a dotted top-level key', () => {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ 'models.embedding.default': { backend: 'openai' } });

			assert.equal(startModelsConfigHotReload(), false, 'dotted keys compose into models and pin it');
		});

		it('subscribes to the isolate-shared watcher and unsubscribes without closing it', () => {
			// Logging already opens one root-config watcher per worker; models must ride the same
			// instance instead of doubling the native-watcher footprint (review finding).
			const shared = getSharedRootConfigWatcher();
			shared.ready.catch(() => {});
			const before = shared.listenerCount('change');

			assert.equal(startModelsConfigHotReload(), true);
			assert.equal(shared.listenerCount('change'), before + 1, 'models subscribed to the shared watcher');

			stopModelsConfigHotReload();
			assert.equal(shared.listenerCount('change'), before, 'stop unsubscribes without closing');
		});

		for (const layer of ENV_LAYERS) {
			it(`stays off when ${layer} also defines models, so boot semantics keep ruling`, () => {
				// The compatibility gate: an orchestrator still injecting models through an env layer
				// keeps today's restart behavior; the file is not authoritative for the block. Each
				// layer is asserted independently — a typo in one name would silently un-gate it.
				process.env[layer] = JSON.stringify({ models: { embedding: {} } });

				assert.equal(startModelsConfigHotReload(), false);
			});
		}

		it('a boot discards a watcher snapshot whose settle timer has not fired yet', async function () {
			this.timeout(10000);
			// The exact race the debounce guard exists for: content observed BEFORE the boot must not
			// apply after it. onSnapshotObserved makes the observation moment deterministic.
			const fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.models-reload-'));
			const configFilePath = join(fixture, 'config.yaml');
			try {
				writeFileSync(configFilePath, stringify({ models: block({ keeper: openaiEntry('sk-a') }) }));
				await bootstrapModels({ models: block({ keeper: openaiEntry('sk-a') }) });
				let observations = 0;
				assert.equal(
					startModelsConfigHotReload({
						configFilePath,
						debounceMs: 300,
						onSnapshotObserved: () => observations++,
					}),
					true
				);
				await waitFor(() => observations >= 1, { message: 'watcher never became ready' });
				const observedBeforeBoot = observations;

				writeFileSync(
					configFilePath,
					stringify({ models: block({ keeper: openaiEntry('sk-a'), stale: openaiEntry('sk-stale') }) })
				);
				await waitFor(() => observations > observedBeforeBoot, { message: 'rewrite never observed' });

				// Observed, timer armed, not yet fired: the boot must cancel it.
				await bootstrapModels({ models: block({ keeper: openaiEntry('sk-boot') }) });

				await new Promise((resolve) => setTimeout(resolve, 500));
				assert.equal(getBackend('embedding', 'stale'), undefined, 'pre-boot snapshot discarded');
				assert.ok(getBackend('embedding', 'keeper'), 'boot content stands');
			} finally {
				stopModelsConfigHotReload();
				rmSync(fixture, { recursive: true, force: true });
			}
		});

		it('applies a config file rewrite to live requests, with no restart', async function () {
			this.timeout(10000);
			const fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.models-reload-'));
			const configFilePath = join(fixture, 'config.yaml');
			const captured = installFetchCapture();
			try {
				writeFileSync(configFilePath, stringify({ models: block({ default: openaiEntry('sk-boot') }) }));
				await bootstrapModels({ models: block({ default: openaiEntry('sk-boot') }) });
				assert.equal(startModelsConfigHotReload({ configFilePath, debounceMs: 10 }), true);

				await resolveEmbedding('default').embed('hello', { model: 'text-embedding-3-small' });
				assert.equal(captured.sent.at(-1), 'Bearer sk-boot');

				writeFileSync(configFilePath, stringify({ models: block({ default: openaiEntry('sk-rewritten') }) }));
				await waitFor(
					async () => {
						// Observed through the request path itself: the rewrite has landed once an embed
						// call presents the new credential.
						await resolveEmbedding('default').embed('hello', { model: 'text-embedding-3-small' });
						return captured.sent.at(-1) === 'Bearer sk-rewritten';
					},
					{ timeout: 8000, message: 'the rewritten credential never reached requests' }
				);
			} finally {
				captured.restore();
				rmSync(fixture, { recursive: true, force: true });
			}
		});
	});
});
