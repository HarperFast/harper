'use strict';

const assert = require('node:assert');
const {
	setEmbedding,
	setGenerative,
	resolveEmbedding,
	resolveGenerative,
	clearRegistry,
	registerBackend,
	defineBackend,
	ModelBackendNotFoundError,
	ModelBackendRegistrationError,
	getBackend,
	replaceIfCurrent,
	removeIfCurrent,
	constructBackend,
} = require('#src/resources/models/backendRegistry');

function fakeBackend(name) {
	return {
		name,
		capabilities: () => ({ embed: true, generate: true, stream: true, tools: false, adapters: false }),
	};
}

describe('backendRegistry', () => {
	beforeEach(() => {
		clearRegistry();
	});

	it('resolves an embedding backend by logical name', () => {
		const backend = fakeBackend('test');
		setEmbedding('default', backend);
		assert.strictEqual(resolveEmbedding('default'), backend);
	});

	it("defaults logicalName to 'default' when omitted", () => {
		const backend = fakeBackend('test');
		setEmbedding('default', backend);
		assert.strictEqual(resolveEmbedding(), backend);
	});

	it('resolves multiple logical names to different backends', () => {
		const a = fakeBackend('a');
		const b = fakeBackend('b');
		setEmbedding('default', a);
		setEmbedding('fast', b);
		assert.strictEqual(resolveEmbedding('default'), a);
		assert.strictEqual(resolveEmbedding('fast'), b);
	});

	it('resolves generative independently from embedding', () => {
		const e = fakeBackend('emb');
		const g = fakeBackend('gen');
		setEmbedding('default', e);
		setGenerative('default', g);
		assert.strictEqual(resolveEmbedding('default'), e);
		assert.strictEqual(resolveGenerative('default'), g);
	});

	it('throws ModelBackendNotFoundError when no backend is registered for the name', () => {
		assert.throws(
			() => resolveEmbedding('missing'),
			(err) => err instanceof ModelBackendNotFoundError && err.statusCode === 500
		);
	});

	it('re-mapping the same logical name replaces the prior backend', () => {
		const first = fakeBackend('first');
		const second = fakeBackend('second');
		setEmbedding('default', first);
		setEmbedding('default', second);
		assert.strictEqual(resolveEmbedding('default'), second);
	});

	it('clearRegistry() removes all mappings', () => {
		setEmbedding('default', fakeBackend('test'));
		setGenerative('default', fakeBackend('test'));
		clearRegistry();
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
		assert.throws(() => resolveGenerative('default'), ModelBackendNotFoundError);
	});

	it('error message identifies kind + logical name but never enumerates other registrations', () => {
		setEmbedding('default', fakeBackend('secret-backend-name'));
		try {
			resolveEmbedding('other');
			assert.fail('expected error');
		} catch (err) {
			assert.ok(!err.message.includes('secret-backend-name'), 'error should not enumerate registered backend names');
			assert.ok(err.message.includes('embedding.other'));
		}
	});
});

describe('registerBackend', () => {
	const embedSpec = { embed: async () => ({ status: 'completed', output: [] }) };
	const generateSpec = {
		generate: async () => ({ status: 'completed', output: { content: '', finishReason: 'stop' } }),
	};

	beforeEach(() => clearRegistry());

	it('registers and resolves an embedding backend by id', () => {
		const backend = defineBackend({ name: 'local:e', ...embedSpec });
		registerBackend('embedding', 'local:e', backend);
		assert.strictEqual(resolveEmbedding('local:e'), backend);
	});

	it('registers and resolves a generative backend by id', () => {
		const backend = defineBackend({ name: 'local:g', ...generateSpec });
		registerBackend('generative', 'local:g', backend);
		assert.strictEqual(resolveGenerative('local:g'), backend);
	});

	it('accepts a stream-only generative backend', () => {
		const backend = defineBackend({ name: 'local:s', generateStream: async function* () {} });
		registerBackend('generative', 'local:s', backend);
		assert.strictEqual(resolveGenerative('local:s'), backend);
	});

	it('re-registering the same id replaces the prior backend', () => {
		const a = defineBackend({ name: 'a', ...embedSpec });
		const b = defineBackend({ name: 'b', ...embedSpec });
		registerBackend('embedding', 'x', a);
		registerBackend('embedding', 'x', b);
		assert.strictEqual(resolveEmbedding('x'), b);
	});

	it('throws on an invalid kind', () => {
		assert.throws(() => registerBackend('bogus', 'x', fakeBackend('k')), ModelBackendRegistrationError);
	});

	it('throws on an empty id', () => {
		assert.throws(
			() => registerBackend('embedding', '', defineBackend({ name: 'k', ...embedSpec })),
			ModelBackendRegistrationError
		);
	});

	it('throws when an embedding backend has no embed()', () => {
		assert.throws(
			() => registerBackend('embedding', 'x', defineBackend({ name: 'g-only', ...generateSpec })),
			ModelBackendRegistrationError
		);
	});

	it('throws when a generative backend has neither generate() nor generateStream()', () => {
		assert.throws(
			() => registerBackend('generative', 'x', defineBackend({ name: 'e-only', ...embedSpec })),
			ModelBackendRegistrationError
		);
	});

	it('throws when the backend lacks a name or capabilities()', () => {
		assert.throws(() => registerBackend('embedding', 'x', { embed: async () => ({}) }), ModelBackendRegistrationError);
	});

	// Config hot reload depends on these (#2344): build what boot would have built, then install it
	// only if nothing else claimed the slot meanwhile.
	describe('conditional replacement (#2344)', () => {
		it('replaces the entry when it is still the expected instance', () => {
			const original = fakeBackend('original');
			const next = fakeBackend('next');
			setEmbedding('default', original);

			assert.equal(replaceIfCurrent('embedding', 'default', original, next), true);
			assert.equal(getBackend('embedding', 'default'), next);
		});

		it('refuses, and writes nothing, when another writer already changed the entry', () => {
			// The slot-clobber race: a plain set resolves by arrival order, so an older credential could
			// otherwise overwrite a newer registration.
			const original = fakeBackend('original');
			const interloper = fakeBackend('interloper');
			const next = fakeBackend('next');
			setEmbedding('default', original);
			setEmbedding('default', interloper); // a concurrent structural reload or registerBackend

			assert.equal(replaceIfCurrent('embedding', 'default', original, next), false);
			assert.equal(getBackend('embedding', 'default'), interloper, 'the other writer survives');
		});

		it('treats an absent entry as expected-undefined', () => {
			const next = fakeBackend('next');
			assert.equal(replaceIfCurrent('generative', 'fresh', undefined, next), true);
			assert.equal(getBackend('generative', 'fresh'), next);
		});

		it('does not install the entry it was asked to replace when the expectation fails', () => {
			const original = fakeBackend('original');
			setEmbedding('default', original);
			assert.equal(
				replaceIfCurrent('embedding', 'default', fakeBackend('never-installed'), fakeBackend('next')),
				false
			);
			assert.equal(getBackend('embedding', 'default'), original);
		});

		it('builds a backend through its registration path without installing it', async () => {
			// Rotation needs the constructed instance so the install can be conditional; the factory would
			// otherwise install unconditionally as its last act.
			const built = fakeBackend('built');
			const { backend } = await constructBackend('embedding', 'default', () => setEmbedding('default', built));

			assert.equal(backend, built, 'the constructed backend is handed back');
			assert.equal(getBackend('embedding', 'default'), undefined, 'and NOT installed');
		});

		it("defers a factory's secondary registrations to the caller instead of installing mid-construction", async () => {
			// A helper installed live during a slow construction would pair a NEW helper with the OLD
			// primary for any request arriving in the window.
			const helper = fakeBackend('helper');
			const built = fakeBackend('built');
			const { backend, extras } = await constructBackend('embedding', 'default', () => {
				setEmbedding('default-helper', helper);
				setEmbedding('default', built);
			});

			assert.equal(backend, built);
			assert.deepEqual(extras, [{ kind: 'embedding', logicalName: 'default-helper', backend: helper }]);
			assert.equal(getBackend('embedding', 'default-helper'), undefined, 'helper deferred, not installed');
			assert.equal(getBackend('embedding', 'default'), undefined);
		});

		it('lets async work spawned by a factory install normally after construction ends', async () => {
			// The ALS context outlives the run() for async descendants; deactivation is what keeps a
			// late same-slot registration from being silently swallowed into a dead capture.
			const built = fakeBackend('built');
			const lateBackend = fakeBackend('late');
			let late;
			await constructBackend('embedding', 'default', () => {
				late = (async () => {
					await new Promise((resolve) => setImmediate(resolve));
					setEmbedding('default', lateBackend);
				})();
				setEmbedding('default', built);
			});
			await late;

			assert.equal(getBackend('embedding', 'default'), lateBackend, 'the late install reaches the registry');
		});

		it('clears the capture scope even when the factory throws', async () => {
			await assert.rejects(() =>
				constructBackend('embedding', 'default', () => {
					throw new Error('factory blew up');
				})
			);
			// A leaked scope would silently swallow the next registration for this name.
			const after = fakeBackend('after');
			setEmbedding('default', after);
			assert.equal(getBackend('embedding', 'default'), after);
		});

		it('does not divert an unrelated registration that lands while a construction is awaiting', async () => {
			// The capture is scoped to the async context: only the factory's OWN installs defer. A
			// concurrent registration from elsewhere must install live, not be swallowed or deferred.
			const unrelated = fakeBackend('unrelated');
			const built = fakeBackend('built');
			let release;
			const gate = new Promise((resolve) => (release = resolve));
			const constructing = constructBackend('embedding', 'default', async () => {
				await gate;
				setEmbedding('default', built);
			});

			setEmbedding('other', unrelated);
			assert.equal(getBackend('embedding', 'other'), unrelated, 'installed live, mid-construction');

			release();
			const { backend, extras } = await constructing;
			assert.equal(backend, built);
			assert.deepEqual(extras, [], 'the outside registration was not captured');
			assert.equal(getBackend('embedding', 'default'), undefined);
		});

		it('keeps two concurrent constructions separate', async () => {
			// Two entries rotating at once must not collide; a module-global capture slot made the second
			// one fail and drop its event.
			const first = fakeBackend('first');
			const second = fakeBackend('second');
			const [a, b] = await Promise.all([
				constructBackend('embedding', 'one', async () => {
					await Promise.resolve();
					setEmbedding('one', first);
				}),
				constructBackend('embedding', 'two', async () => {
					setEmbedding('two', second);
				}),
			]);

			assert.equal(a.backend, first);
			assert.equal(b.backend, second);
			assert.equal(getBackend('embedding', 'one'), undefined);
			assert.equal(getBackend('embedding', 'two'), undefined);
		});

		it('removes an entry only while it is still the expected instance', () => {
			const mine = fakeBackend('mine');
			setEmbedding('default', mine);
			assert.equal(removeIfCurrent('embedding', 'default', mine), true);
			assert.equal(getBackend('embedding', 'default'), undefined);

			const theirs = fakeBackend('theirs');
			setEmbedding('default', theirs);
			assert.equal(removeIfCurrent('embedding', 'default', mine), false, 'not ours to remove');
			assert.equal(getBackend('embedding', 'default'), theirs);
		});
	});
});
