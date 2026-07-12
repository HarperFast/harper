'use strict';

const assert = require('node:assert');
// Prime the module graph in the same order the other models unit tests do.
require('#src/resources/databases');
const { registerRouter, getRouter, setFallbackGroup, clearRouting } = require('#src/resources/models/routing');
const { setGenerative, defineBackend, clearRegistry } = require('#src/resources/models/backendRegistry');
const { Models } = require('#src/resources/models/Models');

function makeWriter() {
	const records = [];
	return { records, write: (r) => records.push(r) };
}
const genOut = (content) => ({ status: 'completed', output: { content, finishReason: 'stop' } });
const TOOLS_INPUT = {
	messages: [{ role: 'user', content: 'hi' }],
	tools: [{ name: 't', description: 'd', parameters: {} }],
};

describe('default router', () => {
	beforeEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('returns the single registered backend for a logical name', () => {
		const b = defineBackend({ name: 'g', generate: async () => genOut('x') });
		setGenerative('default', b);
		assert.deepStrictEqual(getRouter().route({ kind: 'generative', logicalName: 'default', requires: ['generate'] }), [
			b,
		]);
	});

	it('returns empty for an unregistered name', () => {
		assert.deepStrictEqual(getRouter().route({ kind: 'generative', logicalName: 'nope', requires: [] }), []);
	});

	it('filters out candidates lacking a required capability', () => {
		setGenerative('default', defineBackend({ name: 'no-tools', generate: async () => genOut('x') }));
		assert.deepStrictEqual(getRouter().route({ kind: 'generative', logicalName: 'default', requires: ['tools'] }), []);
	});

	it('expands a fallback group in order, capability-filtered', () => {
		const a = defineBackend({ name: 'a', generate: async () => genOut('a') });
		const b = defineBackend({ name: 'b', tools: true, generate: async () => genOut('b') });
		setGenerative('default', a);
		setGenerative('alt', b);
		setFallbackGroup('generative', 'default', ['alt']);
		assert.deepStrictEqual(getRouter().route({ kind: 'generative', logicalName: 'default', requires: [] }), [a, b]);
		assert.deepStrictEqual(getRouter().route({ kind: 'generative', logicalName: 'default', requires: ['tools'] }), [b]);
	});

	it('registerRouter replaces the default policy', () => {
		const sentinel = defineBackend({ name: 'sentinel', generate: async () => genOut('s') });
		const custom = { route: () => [sentinel] };
		registerRouter(custom);
		assert.strictEqual(getRouter(), custom);
		assert.deepStrictEqual(getRouter().route({ kind: 'generative', logicalName: 'anything', requires: [] }), [
			sentinel,
		]);
	});

	it('models.registerRouter installs a custom router (namespaced under models, not a global)', () => {
		const sentinel = defineBackend({ name: 's', generate: async () => genOut('s') });
		new Models(makeWriter(), () => {}).registerRouter({ route: () => [sentinel] });
		assert.deepStrictEqual(getRouter().route({ kind: 'generative', logicalName: 'x', requires: [] }), [sentinel]);
	});
});

describe('Models routing (end-to-end)', () => {
	beforeEach(() => {
		clearRegistry();
		clearRouting();
	});
	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('capability-routes generate({tools}) to a tools-capable backend in the group', async () => {
		setGenerative('default', defineBackend({ name: 'plain', generate: async () => genOut('plain') }));
		setGenerative('tooled', defineBackend({ name: 'tooled', tools: true, generate: async () => genOut('tooled') }));
		setFallbackGroup('generative', 'default', ['tooled']);
		const models = new Models(makeWriter(), () => {});
		const result = await models.generate(TOOLS_INPUT);
		assert.strictEqual(result.content, 'tooled'); // the no-tools 'default' was filtered out
	});

	it('falls back to the next candidate on error, recording each attempt', async () => {
		setGenerative(
			'default',
			defineBackend({
				name: 'failing',
				generate: async () => {
					throw new Error('boom');
				},
			})
		);
		setGenerative('backup', defineBackend({ name: 'backup', generate: async () => genOut('recovered') }));
		setFallbackGroup('generative', 'default', ['backup']);
		const writer = makeWriter();
		const result = await new Models(writer, () => {}).generate('hi');
		assert.strictEqual(result.content, 'recovered');
		assert.strictEqual(writer.records.length, 2);
		assert.strictEqual(writer.records[0].success, false);
		assert.strictEqual(writer.records[0].backend, 'failing');
		assert.strictEqual(writer.records[1].success, true);
		assert.strictEqual(writer.records[1].backend, 'backup');
	});

	it('surfaces the primary (first) error, not the last candidate, when the whole chain fails (#1537)', async () => {
		setGenerative(
			'default',
			defineBackend({
				name: 'primary',
				generate: async () => {
					throw new Error('primary boom');
				},
			})
		);
		setGenerative(
			'backup',
			defineBackend({
				name: 'backup',
				generate: async () => {
					throw new Error('backup boom');
				},
			})
		);
		setFallbackGroup('generative', 'default', ['backup']);
		const writer = makeWriter();
		// The primary is what the caller asked for, so its error is the most diagnostic.
		await assert.rejects(() => new Models(writer, () => {}).generate('hi'), /primary boom/);
		// Every candidate is still attempted and recorded — only the surfaced error changed.
		assert.strictEqual(writer.records.length, 2);
		assert.strictEqual(writer.records[0].backend, 'primary');
		assert.strictEqual(writer.records[1].backend, 'backup');
	});

	it('generateStream throws synchronously for an unknown model (regression guard)', () => {
		const models = new Models(makeWriter(), () => {});
		assert.throws(() => models.generateStream('hi', { model: 'missing' }), { name: 'ModelBackendNotFoundError' });
	});

	it('throws ModelCapabilityError (named backend) when no candidate satisfies requires', async () => {
		setGenerative('default', defineBackend({ name: 'no-tools', generate: async () => genOut('x') }));
		const writer = makeWriter();
		await assert.rejects(() => new Models(writer, () => {}).generate(TOOLS_INPUT), { name: 'ModelCapabilityError' });
		assert.strictEqual(writer.records[0].backend, 'no-tools'); // recorded with the resolved name, not 'unknown'
	});

	it('does not fall through to the next candidate when the caller has aborted', async () => {
		const controller = new AbortController();
		let backupTried = false;
		setGenerative(
			'default',
			defineBackend({
				name: 'first',
				generate: async () => {
					controller.abort();
					throw new Error('failed after caller abort');
				},
			})
		);
		setGenerative(
			'backup',
			defineBackend({
				name: 'backup',
				generate: async () => {
					backupTried = true;
					return genOut('x');
				},
			})
		);
		setFallbackGroup('generative', 'default', ['backup']);
		await assert.rejects(() => new Models(makeWriter(), () => {}).generate('hi', { signal: controller.signal }));
		assert.strictEqual(backupTried, false); // caller abort short-circuits the fallback loop
	});

	it('does not call any backend when the signal is already aborted on entry', async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		setGenerative(
			'default',
			defineBackend({
				name: 'first',
				generate: async () => {
					called = true;
					return genOut('x');
				},
			})
		);
		await assert.rejects(() => new Models(makeWriter(), () => {}).generate('hi', { signal: controller.signal }));
		assert.strictEqual(called, false); // top-of-loop abort guard skips the wasted call
	});

	it('throws a plain "no candidates" error (not ModelCapabilityError) when a custom router returns empty for a satisfying backend', async () => {
		setGenerative('default', defineBackend({ name: 'capable', generate: async () => genOut('x') }));
		registerRouter({ route: () => [] }); // a custom router declines every candidate
		await assert.rejects(
			() => new Models(makeWriter(), () => {}).generate('hi'),
			(err) => {
				// The backend supports generate — the empty result is a routing decision,
				// so the error must not claim a capability gap.
				assert.notStrictEqual(err.name, 'ModelCapabilityError');
				assert.match(err.message, /No routing candidates available/);
				return true;
			}
		);
	});
});
