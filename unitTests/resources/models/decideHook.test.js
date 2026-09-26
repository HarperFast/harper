'use strict';

const assert = require('node:assert');
const { buildDecideBefore, createDefaultDecider, __setDecideFnForTest } = require('#src/resources/models/decideHook');
const { buildEmbedBefore, combineWriteHooks } = require('#src/resources/models/embedHook');

const ROUTES = ['billing', 'refund', 'bug'];
const config = { source: 'body', model: 'default', confidence: 'routeConfidence', schema: { enum: ROUTES } };
const attrs = [{ name: 'route', decide: config }];
const REFUND = { value: 'refund', probability: 0.75 };

function fakeDecideCapturing(result = REFUND) {
	const calls = [];
	const fn = async (state, schema, opts) => {
		calls.push({ state, schema, opts });
		return { id: 'row', calibrated: false, ...result };
	};
	fn.calls = calls;
	return fn;
}

describe('decideHook', () => {
	describe('createDefaultDecider', () => {
		afterEach(() => __setDecideFnForTest(undefined));

		it('reads the source field, calls Models.decide with the leaf, model and instructions, returns value and probability', async () => {
			const decideFn = fakeDecideCapturing();
			__setDecideFnForTest(decideFn);
			const decider = createDefaultDecider({ ...config, instructions: 'Route the ticket.' });
			assert.deepEqual(await decider({ body: 'refund me' }), REFUND);
			assert.equal(decideFn.calls.length, 1);
			assert.equal(decideFn.calls[0].state, 'refund me');
			assert.deepEqual(decideFn.calls[0].schema, { enum: ROUTES });
			assert.deepEqual(decideFn.calls[0].opts, { model: 'default', instructions: 'Route the ticket.' });
		});

		it('returns null without calling the model when the source is null or undefined', async () => {
			const decideFn = fakeDecideCapturing();
			__setDecideFnForTest(decideFn);
			const decider = createDefaultDecider(config);
			assert.equal(await decider({ body: null }), null);
			assert.equal(await decider({}), null);
			assert.equal(decideFn.calls.length, 0);
		});

		it('passes an object source as program state and stringifies other non-string sources', async () => {
			const decideFn = fakeDecideCapturing();
			__setDecideFnForTest(decideFn);
			const decider = createDefaultDecider(config);
			await decider({ body: { subject: 'x', lines: 3 } });
			assert.deepEqual(decideFn.calls[0].state, { subject: 'x', lines: 3 });
			await decider({ body: 42 });
			assert.equal(decideFn.calls[1].state, '42');
		});
	});

	describe('buildDecideBefore', () => {
		const deciders = { route: async () => REFUND };

		it('returns undefined when there are no @decide attributes', () => {
			assert.equal(buildDecideBefore({ body: 'x' }, {}, {}, [], deciders), undefined);
			assert.equal(buildDecideBefore({ body: 'x' }, {}, {}, undefined, deciders), undefined);
		});

		it('returns undefined on replication receive, x-replicate-from: none, and replay', () => {
			assert.equal(buildDecideBefore({ body: 'x' }, {}, { isNotification: true }, attrs, deciders), undefined);
			assert.equal(buildDecideBefore({ body: 'x' }, { replicateFrom: false }, {}, attrs, deciders), undefined);
			assert.equal(buildDecideBefore({ body: 'x' }, { alreadyLogged: true }, {}, attrs, deciders), undefined);
		});

		it('a replicated payload that carries the source but no decision is stored as it arrived', async () => {
			// An originator without the directive (mixed-version rollout) commits the source alone; the
			// receiver never re-decides, so the row keeps whatever the originator wrote.
			const record = { body: 'x' };
			assert.equal(buildDecideBefore(record, {}, { isNotification: true }, attrs, deciders), undefined);
			assert.deepEqual(record, { body: 'x' });
		});

		it('fires on a local-originating write where replicateFrom is undefined', () => {
			assert.ok(buildDecideBefore({ body: 'x' }, {}, {}, attrs, deciders));
		});

		it('returns undefined when no source field is in the payload, or the record is not an object', () => {
			assert.equal(buildDecideBefore({ tag: 'unchanged' }, {}, {}, attrs, deciders), undefined);
			assert.equal(buildDecideBefore({ routeConfidence: 1 }, {}, {}, attrs, deciders), undefined);
			assert.equal(buildDecideBefore(null, {}, {}, attrs, deciders), undefined);
			assert.equal(buildDecideBefore(undefined, {}, {}, attrs, deciders), undefined);
		});

		it('writes the value and its probability when the source is present', async () => {
			const record = { body: 'refund me' };
			const before = buildDecideBefore(record, {}, {}, attrs, {
				route: async (r) => {
					assert.equal(r.body, 'refund me');
					return REFUND;
				},
			});
			assert.ok(before);
			await before();
			assert.equal(record.route, 'refund');
			assert.equal(record.routeConfidence, 0.75);
		});

		it('writes only the value when the directive names no confidence attribute', async () => {
			const record = { body: 'refund me' };
			const before = buildDecideBefore(
				record,
				{},
				{},
				[{ name: 'route', decide: { ...config, confidence: undefined } }],
				deciders
			);
			await before();
			assert.equal(record.route, 'refund');
			assert.equal('routeConfidence' in record, false);
		});

		it('clears value and confidence when the source is explicitly null, without calling the decider', async () => {
			const record = { body: null };
			let called = false;
			const before = buildDecideBefore(record, {}, {}, attrs, {
				route: async () => {
					called = true;
					return REFUND;
				},
			});
			await before();
			assert.equal(record.route, null);
			assert.equal(record.routeConfidence, null);
			assert.equal(called, false);
		});

		it('clears value and confidence when the decider returns null', async () => {
			const record = { body: 'x' };
			const before = buildDecideBefore(record, {}, {}, attrs, { route: async () => null });
			await before();
			assert.equal(record.route, null);
			assert.equal(record.routeConfidence, null);
		});

		it('writes a null confidence when an override returns no probability', async () => {
			const record = { body: 'x' };
			const before = buildDecideBefore(record, {}, {}, attrs, { route: async () => ({ value: 'bug' }) });
			await before();
			assert.equal(record.route, 'bug');
			assert.equal(record.routeConfidence, null);
		});

		it('skips attributes whose source is not in the payload and attributes with no registered decider', async () => {
			const multi = [
				attrs[0],
				{ name: 'urgent', decide: { source: 'title', model: 'default', schema: { type: 'boolean' } } },
			];
			const record = { body: 'x' };
			let urgentCalls = 0;
			const before = buildDecideBefore(record, {}, {}, multi, {
				route: async () => REFUND,
				urgent: async () => {
					urgentCalls++;
					return { value: true, probability: 1 };
				},
			});
			await before();
			assert.equal(urgentCalls, 0);
			assert.equal(record.urgent, undefined);
			assert.equal(record.route, 'refund');

			const unregistered = { body: 'x' };
			await buildDecideBefore(unregistered, {}, {}, attrs, {})();
			assert.deepEqual(unregistered, { body: 'x' });
		});

		it('skips the decider when the source payload is a CRDT operation', async () => {
			const record = { body: { __op__: 'add', value: 5 } };
			let called = false;
			const before = buildDecideBefore(record, {}, {}, attrs, {
				route: async () => {
					called = true;
					return REFUND;
				},
			});
			await before();
			assert.equal(called, false);
			assert.equal(record.route, undefined);
		});

		it('fails the write when an override returns a value outside the closed set or a bad probability', async () => {
			for (const [result, pattern] of [
				[{ value: 'shipping', probability: 1 }, /outside its @decide set/],
				[{ value: 'bug', probability: 1.5 }, /not a number in \[0, 1\]/],
				[{ value: 'bug', probability: NaN }, /not a number in \[0, 1\]/],
				[{ value: 'bug', probability: '0.5' }, /not a number in \[0, 1\]/],
			]) {
				const record = { body: 'x' };
				await assert.rejects(buildDecideBefore(record, {}, {}, attrs, { route: async () => result })(), pattern);
				assert.equal(record.route, undefined, 'nothing is written on failure');
				assert.equal(record.routeConfidence, undefined);
			}
		});

		it('checks an integer value against its range', async () => {
			const intAttrs = [
				{
					name: 'severity',
					decide: { source: 'body', model: 'default', schema: { type: 'integer', minimum: 1, maximum: 5 } },
				},
			];
			const ok = { body: 'x' };
			await buildDecideBefore(ok, {}, {}, intAttrs, { severity: async () => ({ value: 3, probability: 0.5 }) })();
			assert.equal(ok.severity, 3);
			await assert.rejects(
				buildDecideBefore({ body: 'x' }, {}, {}, intAttrs, {
					severity: async () => ({ value: 6, probability: 0.5 }),
				})(),
				/outside its @decide set/
			);
			await assert.rejects(
				buildDecideBefore({ body: 'x' }, {}, {}, intAttrs, {
					severity: async () => ({ value: '3', probability: 0.5 }),
				})(),
				/outside its @decide set/
			);
		});

		it('propagates a sanitized error when the decider throws, with only safe identifiers', async () => {
			const record = { body: 'x' };
			const backendError = new Error('https://internal-llm.svc:9000 404 key=sk-abc123 models/default is not found');
			backendError.name = 'OpenAIBackendError';
			backendError.upstreamStatus = 404;
			backendError.statusCode = 500;
			await assert.rejects(
				buildDecideBefore(record, {}, {}, attrs, {
					route: async () => {
						throw backendError;
					},
				})(),
				(err) => {
					assert.ok(!/sk-abc123/.test(err.message), 'API key tail leaked');
					assert.ok(!/internal-llm\.svc/.test(err.message), 'internal hostname leaked');
					assert.match(err.message, /decision for attribute "route" \[OpenAIBackendError\] \(backend HTTP 404\)/);
					assert.ok(!/500/.test(err.message), "Harper's own statusCode must not be labeled as the backend status");
					assert.match(err.message, /server log/i);
					return true;
				}
			);
			assert.equal(record.route, undefined);
		});

		it('drops an error name that is not identifier-shaped and a status that is not an HTTP status', async () => {
			const backendError = new Error('boom');
			backendError.name = 'Error at https://internal-llm.svc/v1?key=sk-abc123';
			backendError.upstreamStatus = 12345;
			await assert.rejects(
				buildDecideBefore({ body: 'x' }, {}, {}, attrs, {
					route: async () => {
						throw backendError;
					},
				})(),
				(err) => {
					assert.equal(err.message, 'Failed to compute decision for attribute "route" — see server log for details');
					return true;
				}
			);
		});

		it('settles every decider before reporting a failure, so a slow one cannot write after the rejection', async () => {
			const multi = [
				attrs[0],
				{ name: 'urgent', decide: { source: 'body', model: 'default', schema: { type: 'boolean' } } },
			];
			const record = { body: 'x' };
			let slowDone = false;
			await assert.rejects(
				buildDecideBefore(record, {}, {}, multi, {
					route: async () => {
						throw new Error('fast failure');
					},
					urgent: async () => {
						await new Promise((resolve) => setTimeout(resolve, 20));
						slowDone = true;
						return { value: true, probability: 1 };
					},
				})(),
				/decision for attribute "route"/
			);
			assert.equal(slowDone, true, 'the slow decider settled before the failure was reported');
			assert.equal(record.urgent, true);
		});
	});

	describe('combineWriteHooks', () => {
		it('returns undefined with no hooks, the hook itself with one, and runs both concurrently with two', async () => {
			assert.equal(combineWriteHooks(undefined, undefined), undefined);
			const only = async () => {};
			assert.equal(combineWriteHooks(undefined, only), only);
			const record = { content: 'x', body: 'refund me' };
			const combined = combineWriteHooks(
				buildEmbedBefore(record, {}, {}, [{ name: 'embedding', embed: { source: 'content', model: 'default' } }], {
					embedding: async () => [1, 2, 3],
				}),
				buildDecideBefore(record, {}, {}, attrs, { route: async () => REFUND })
			);
			await combined();
			assert.deepEqual(record.embedding, [1, 2, 3]);
			assert.equal(record.route, 'refund');
			assert.equal(record.routeConfidence, 0.75);
		});

		it('settles the other hook before reporting one hook’s failure', async () => {
			let slowDone = false;
			const combined = combineWriteHooks(
				async () => {
					throw new Error('embed failed');
				},
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					slowDone = true;
				}
			);
			await assert.rejects(combined(), /embed failed/);
			assert.equal(slowDone, true);
		});
	});
});
