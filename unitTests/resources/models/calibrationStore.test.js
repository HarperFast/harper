'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { contextStorage, transaction } = require('#src/resources/transaction');
const { setDecision, clearRegistry, defineBackend } = require('#src/resources/models/backendRegistry');
const { clearRouting } = require('#src/resources/models/routing');
const { Models } = require('#src/resources/models/Models');
const { getDecisionTables, resetDecisionTables } = require('#src/resources/models/decisionStore');
const {
	applyFits,
	calibrationJob,
	processingOrder,
	configureCalibration,
	getCalibrationsTable,
	outstandingCalibrationReads,
	resetCalibrationCache,
	resetCalibrationsTable,
	runCalibration,
	setCalibrationReadForTests,
} = require('#src/resources/models/calibrationStore');
const { calibrationKey, populationKey } = require('#src/resources/models/calibration');

const VALUES = ['a', 'b', 'c'];
const SCHEMA = { enum: VALUES };
const SIGNATURE = 'scorer=v1';
const CONFIG = { minReport: 20, minTrain: 100, minHeldOut: 60, heldOutShare: 0.3, eceMargin: 0.01 };

// Case i: the truth cycles through the values, and the scorer's top value is right 60% of the time at 0.9.
function truthOf(i) {
	return VALUES[i % 3];
}
function topOf(i) {
	return i % 5 < 3 ? truthOf(i) : VALUES[(i + 1) % 3];
}
function distributionFor(state) {
	const i = Number(/case-(\d+)/.exec(state)?.[1] ?? 0);
	const top = topOf(i);
	return VALUES.map((value) => ({ value, probability: value === top ? 0.9 : 0.05 })).sort(
		(x, y) => y.probability - x.probability
	);
}

function scorer(signature = SIGNATURE) {
	return defineBackend({
		name: 'scorer',
		decide: async (state) => ({ status: 'completed', output: { distribution: distributionFor(state), signature } }),
	});
}

function makeWriter() {
	let nextId = 1;
	return { write: () => nextId++ };
}

async function waitFor(condition, what, timeoutMs = 2000) {
	const started = Date.now();
	while (!(await condition())) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function clearTable(tbl) {
	const ids = [];
	await transaction({}, async () => {
		for await (const row of tbl.search({
			conditions: [{ attribute: 'expiresAt', comparator: 'greater_than', value: 0 }],
		}))
			ids.push(row.id);
	});
	for (const id of ids) await transaction({}, () => tbl.delete(id));
}

async function clearAll() {
	const { decisions, outcomes } = getDecisionTables();
	await clearTable(decisions);
	await clearTable(outcomes);
	await clearTable(getCalibrationsTable());
	resetCalibrationCache();
}

/** Record `count` decisions starting at case `from`, each with its truth. */
async function recordCases(models, from, count, opts = {}) {
	const ids = [];
	for (let i = from; i < from + count; i++) {
		const d = await models.decide(`case-${i}`, SCHEMA, { persist: true, ...opts });
		await models.recordOutcome(d.id, { truth: { kind: 'value', value: truthOf(i) } });
		ids.push(d.id);
	}
	return ids;
}

/** Instructions hashes of the populations the store knows, discovered or fitted. */
async function knownInstructions() {
	const tbl = getCalibrationsTable();
	const out = new Set();
	await transaction({}, async () => {
		for await (const row of tbl.search({ conditions: [{ attribute: 'kind', value: 'population' }] }))
			out.add(row.instructionsHash ?? 'none');
	});
	return out;
}

/** Decide until the cache has loaded, and return the first decision made after it did. */
async function warmDecide(models, state, opts = {}) {
	await models.decide(state, SCHEMA, opts);
	await waitFor(() => outstandingCalibrationReads() === 0, 'the fit lookup');
	return models.decide(state, SCHEMA, opts);
}

describe('calibration store and facade (#2841)', function () {
	this.timeout(30_000);
	let models;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		resetDecisionTables();
		resetCalibrationsTable();
	});

	beforeEach(async () => {
		clearRegistry();
		clearRouting();
		models = new Models(makeWriter(), () => {});
		setDecision('default', scorer());
		configureCalibration(CONFIG, false);
		setCalibrationReadForTests(undefined);
		await clearAll();
	});

	afterEach(() => {
		configureCalibration(undefined, false);
		setCalibrationReadForTests(undefined);
		clearRegistry();
		clearRouting();
	});

	after(() => {
		resetCalibrationsTable();
		resetDecisionTables();
	});

	it('declares the calibration table replicating, audited, with an indexed rank', () => {
		const tbl = getCalibrationsTable();
		assert.strictEqual(tbl.replicate, true);
		assert.ok(tbl.attributes.find((a) => a.name === 'rank').indexed);
		assert.ok(tbl.attributes.find((a) => a.name === 'expiresAt').expiresAt);
	});

	it('is provisioned the same way on a fresh install and by the 5.3.0 upgrade', () => {
		const systemSchema = require('../../../json/systemSchema.json');
		const stub = systemSchema.hdb_model_calibrations;
		assert.strictEqual(stub.hash_attribute, 'id');
		assert.strictEqual(stub.audit, true, 'auditing is the replication feed');
		const [directive] = require('#src/upgrade/directives/5-3-0').default;
		assert.ok(
			directive.async_functions.some((fn) => fn.name === 'createHdbModelCalibrationsIfMissing'),
			'the upgrade creates the table on an existing install'
		);
		const decisions = getDecisionTables().decisions;
		assert.ok(
			decisions.attributes.find((a) => a.name === 'populationRank')?.indexed,
			'decisions are read newest first within a population'
		);
	});

	it('fits from recorded outcomes and calibrates later decisions without changing their value', async () => {
		await recordCases(models, 0, 300);
		const run = await models.calibrate();
		assert.strictEqual(run.status, 'completed');
		assert.strictEqual(run.written, 1);
		assert.strictEqual(run.eligible, 1);

		const recorded = await warmDecide(models, 'case-1000', { persist: true });
		assert.strictEqual(recorded.calibrated, true);
		assert.strictEqual(recorded.value, topOf(1000));
		assert.ok(recorded.probability < 0.9 && recorded.probability > 0.4, `softened to ${recorded.probability}`);
		const row = await models.getDecision(recorded.id);
		assert.strictEqual(row.calibrated, true);
		assert.deepStrictEqual(row.rawDistribution, distributionFor('case-1000'));
		assert.strictEqual(row.calibration.length, 1);
		assert.strictEqual(typeof row.calibration[0].fitId, 'string');
		assert.strictEqual(row.probability, recorded.probability);

		const unrecorded = await models.decide('case-1001', SCHEMA);
		assert.strictEqual(unrecorded.calibrated, true, 'a fit applies whether or not the call is recorded');
		assert.strictEqual(unrecorded.id, undefined);
	});

	it('calibrates every field of an object schema, or none', async () => {
		const OBJECT = { type: 'object', properties: { first: { enum: VALUES }, second: { enum: VALUES } } };
		setDecision(
			'default',
			defineBackend({
				name: 'fields',
				decide: async (state) => ({
					status: 'completed',
					output: {
						fields: {
							first: { distribution: distributionFor(state) },
							second: { distribution: distributionFor(state) },
						},
						signature: SIGNATURE,
					},
				}),
			})
		);
		for (let i = 0; i < 300; i++) {
			const d = await models.decide(`case-${i}`, OBJECT, { persist: true });
			await models.recordOutcome(d.id, {
				fields: {
					first: { truth: { kind: 'value', value: truthOf(i) } },
					second: { truth: { kind: 'value', value: truthOf(i) } },
				},
			});
		}
		const run = await models.calibrate();
		assert.strictEqual(run.written, 2);
		assert.strictEqual(run.eligible, 2);
		await models.decide('case-1000', OBJECT);
		await waitFor(() => outstandingCalibrationReads() === 0, 'the fit lookups');
		const d = await models.decide('case-1000', OBJECT, { persist: true });
		assert.strictEqual(d.calibrated, true);
		for (const name of ['first', 'second']) {
			assert.strictEqual(d.fields[name].value, topOf(1000));
			assert.ok(d.fields[name].probability < 0.9, `${name} softened`);
		}
		const row = await models.getDecision(d.id);
		assert.strictEqual(row.calibration.length, 2);
		assert.deepStrictEqual(Object.keys(row.rawFields).sort(), ['first', 'second']);
	});

	it('takes only budgets from a run: the fit policy is always the configured one', async () => {
		await recordCases(models, 0, 300);
		await runCalibration({ minTrain: 50, minHeldOut: 20, eceMargin: 0.5 });
		assert.strictEqual((await warmDecide(models, 'case-1100')).calibrated, true);
	});

	it('keeps other populations cached through a run that refits one', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		assert.strictEqual((await warmDecide(models, 'case-1200')).calibrated, true);
		await recordCases(models, 0, 40, { instructions: 'another population' });
		const run = await models.calibrate();
		assert.strictEqual(run.written, 1, 'only the new population is written');
		const d = await models.decide('case-1201', SCHEMA);
		assert.strictEqual(d.calibrated, true, 'the first population stays cached and applies without a reload');
	});

	it('writes nothing new when a run finds the same inputs and policy', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		const again = await models.calibrate();
		assert.strictEqual(again.written, 0);
		assert.ok(again.skipped >= 1);
	});

	it('returns the first decision of a population raw and never waits on storage', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		const cold = await models.decide('case-2000', SCHEMA);
		assert.strictEqual(cold.calibrated, false);
		const stalled = [];
		setCalibrationReadForTests(() => new Promise((resolve) => stalled.push(resolve)));
		resetCalibrationCache();
		for (let i = 0; i < 40; i++) {
			const d = await models.decide(`case-${i}`, SCHEMA, { instructions: `population ${i}` });
			assert.strictEqual(d.calibrated, false);
		}
		assert.strictEqual(outstandingCalibrationReads(), 8, 'outstanding reads stay capped while storage hangs');
		assert.strictEqual(stalled.length, 8, 'no read starts while at capacity');
		for (const resolve of stalled) resolve(null);
		await waitFor(() => outstandingCalibrationReads() === 0, 'stalled reads to drain once they settle');
	});

	it('keeps populations apart: instructions, tenant, and the decision entry each start over', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		assert.strictEqual((await warmDecide(models, 'case-3000')).calibrated, true);
		assert.strictEqual((await warmDecide(models, 'case-3000', { instructions: 'other' })).calibrated, false);
		const tenant = await contextStorage.run({ user: { tenant: 't2' } }, () => warmDecide(models, 'case-3000'));
		assert.strictEqual(tenant.calibrated, false);
		setDecision('default', scorer('scorer=v2'));
		assert.strictEqual((await warmDecide(models, 'case-3000')).calibrated, false, 'a new signature');
	});

	it('learns nothing from an unsigned decision', async () => {
		setDecision(
			'default',
			defineBackend({
				name: 'unsigned',
				decide: async (state) => ({ status: 'completed', output: { distribution: distributionFor(state) } }),
			})
		);
		await recordCases(models, 0, 200);
		const run = await models.calibrate();
		assert.strictEqual(run.discovered, 0);
		assert.strictEqual(run.written, 0);
	});

	it('revokes a fit when corrections leave too few labels, and when they leave none', async () => {
		const ids = await recordCases(models, 0, 300);
		await models.calibrate();
		assert.strictEqual((await warmDecide(models, 'case-4000')).calibrated, true);

		for (const id of ids.slice(10)) await models.recordOutcome(id, { truth: { kind: 'unknown' } });
		const fewer = await models.calibrate();
		assert.strictEqual(fewer.written, 1, 'an ineligible version is written even below minReport');
		resetCalibrationCache();
		assert.strictEqual((await warmDecide(models, 'case-4001')).calibrated, false);

		for (const id of ids.slice(0, 10)) await models.recordOutcome(id, { truth: { kind: 'noMatch' } });
		const none = await models.calibrate();
		assert.strictEqual(none.written, 1, 'a version with no labels at all');
		resetCalibrationCache();
		assert.strictEqual((await warmDecide(models, 'case-4002')).calibrated, false);
	});

	it('orders versions by the evidence they saw, whatever order they are written in', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		const tbl = getCalibrationsTable();
		const population = populationKey({
			model: 'default',
			entry: 'registered:scorer',
			signature: SIGNATURE,
			schemaHash: require('#src/resources/models/decision').hashSchema(SCHEMA),
		});
		const key = calibrationKey(population, undefined);
		const current = await transaction({}, async () => {
			for await (const row of tbl.search({
				conditions: [{ attribute: 'rank', comparator: 'starts_with', value: `${key}|` }],
			}))
				return row;
		});
		assert.ok(current?.eligible, 'the fitted version');
		const pad = (n) => String(n).padStart(16, '0');
		const newer = {
			...current,
			id: 'newer',
			eligible: false,
			reason: 'no-improvement',
			evidenceAt: current.evidenceAt + 1,
		};
		newer.rank = `${key}|${pad(newer.evidenceAt)}|${pad(current.fittedAt)}|newer`;
		const older = { ...current, id: 'older', evidenceAt: current.evidenceAt - 1 };
		older.rank = `${key}|${pad(older.evidenceAt)}|${pad(current.fittedAt + 10)}|older`;
		await transaction({}, () => tbl.put(newer));
		await transaction({}, () => tbl.put(older));
		resetCalibrationCache();
		assert.strictEqual((await warmDecide(models, 'case-5000')).calibrated, false, 'the newer evidence revokes');
	});

	it('never applies a replicated row that does not belong to the key it was read under', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		const tbl = getCalibrationsTable();
		const population = populationKey({
			model: 'default',
			entry: 'registered:scorer',
			signature: SIGNATURE,
			schemaHash: require('#src/resources/models/decision').hashSchema(SCHEMA),
		});
		const key = calibrationKey(population, undefined);
		const current = await transaction({}, async () => {
			for await (const row of tbl.search({
				conditions: [{ attribute: 'rank', comparator: 'starts_with', value: `${key}|` }],
			}))
				return row;
		});
		const forged = {
			...current,
			id: 'forged',
			population: 'someone-else',
			rank: `${key}|9999999999999999|9999999999999999|forged`,
		};
		await transaction({}, () => tbl.put(forged));
		resetCalibrationCache();
		assert.strictEqual(
			(await warmDecide(models, 'case-1800')).calibrated,
			false,
			'a row whose population does not match its key is refused'
		);
	});

	it('moves a population stopped by the byte budget to the back of the queue', async () => {
		await recordCases(models, 0, 30);
		await runCalibration({ maxBytes: 5_000 });
		const tbl = getCalibrationsTable();
		const heads = await transaction({}, async () => {
			const out = [];
			for await (const row of tbl.search({ conditions: [{ attribute: 'kind', value: 'population' }] })) out.push(row);
			return out;
		});
		assert.ok(heads.length >= 1 && heads.every((head) => head.lastFittedAt > 0), 'the stopped population was requeued');
	});

	it('applies nothing fitted under a different policy', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		configureCalibration({ ...CONFIG, minTrain: 150 }, false);
		assert.strictEqual((await warmDecide(models, 'case-6000')).calibrated, false);
	});

	it('returns a decision raw when the lookup fails, even with an error whose message throws', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		const hostile = new Error('x');
		Object.defineProperty(hostile, 'message', {
			get() {
				throw new Error('no message');
			},
		});
		setCalibrationReadForTests(() => Promise.reject(hostile));
		resetCalibrationCache();
		const d = await warmDecide(models, 'case-7000');
		assert.strictEqual(d.calibrated, false);
	});

	it('keeps applying a cached fit while it refreshes, instead of returning a raw decision', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		assert.strictEqual((await warmDecide(models, 'case-1600')).calibrated, true);
		const population = populationKey({
			model: 'default',
			entry: 'registered:scorer',
			signature: SIGNATURE,
			schemaHash: require('#src/resources/models/decision').hashSchema(SCHEMA),
		});
		const decision = {
			value: topOf(1601),
			probability: 0.9,
			distribution: distributionFor('case-1601'),
			calibrated: false,
		};
		const later = applyFits(SCHEMA, decision, population, Date.now() + 61_000);
		assert.ok(later, 'the stale entry is served');
		assert.strictEqual(later.decision.calibrated, true);
		await waitFor(() => outstandingCalibrationReads() === 0, 'the refresh');
	});

	it('never fit-calibrates a schema with a no-match leaf', () => {
		const decision = { value: 'a', probability: 0.9, distribution: distributionFor('case-0'), calibrated: false };
		assert.strictEqual(applyFits({ enum: VALUES, noMatch: true }, decision, 'p'), undefined);
		assert.strictEqual(
			applyFits({ type: 'object', properties: { q: { enum: VALUES, noMatch: true } } }, decision, 'p'),
			undefined
		);
	});

	it("leaves requires: ['calibrated'] routing on the backend's own claim", async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		await warmDecide(models, 'case-8000');
		await assert.rejects(models.decide('case-8001', SCHEMA, { requires: ['calibrated'] }), /calibrated/);
	});

	it('shows a population only to its own tenant, absent matching only absent', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		const mine = await models.getCalibrations();
		assert.strictEqual(mine.length, 1);
		assert.strictEqual(mine[0].eligible, true);
		assert.strictEqual(mine[0].applied, true);
		assert.ok(mine[0].report.calibrated.ece < mine[0].report.raw.ece);
		const other = await contextStorage.run({ user: { tenant: 't2' } }, () => models.getCalibrations());
		assert.deepStrictEqual(other, []);
		assert.deepStrictEqual(await models.getCalibrations({ model: 'triage' }), []);
		assert.strictEqual(
			(await models.getCalibrations({ model: 'default' })).length,
			1,
			'the model filter is applied in the query'
		);
	});

	it('reports raw reliability from 20 labels, before a fit can qualify', async () => {
		await recordCases(models, 0, 40);
		const run = await models.calibrate();
		assert.strictEqual(run.written, 1);
		const [summary] = await models.getCalibrations();
		assert.strictEqual(summary.eligible, false);
		assert.strictEqual(summary.reason, 'too-few-labels');
		assert.strictEqual(summary.report.window, 'all');
		assert.strictEqual(summary.report.labelled, 40);
		assert.strictEqual(summary.report.calibrated, undefined);
	});

	it('stops at its budgets and says which one', async () => {
		await recordCases(models, 0, 50);
		await recordCases(models, 50, 50, { instructions: 'second population' });
		const byPopulations = await runCalibration({ maxPopulations: 1 });
		assert.strictEqual(byPopulations.stoppedBy, 'maxPopulations');
		const byBytes = await runCalibration({ maxBytes: 5_000 });
		assert.strictEqual(byBytes.stoppedBy, 'maxBytes');
		assert.strictEqual(byBytes.written, 0, 'a population cut off by the budget writes nothing');
		assert.ok(byBytes.pending >= 1);
		const tiny = await runCalibration({ maxDecisions: 10 });
		assert.strictEqual(tiny.stoppedBy, 'maxDecisions');
		assert.strictEqual(tiny.scanned, 5, 'discovery takes half the decision budget');
		assert.ok(
			tiny.read <= 6,
			'fitting reads the rest, and at most one decision more to tell a truncated population from one that fits'
		);
		assert.strictEqual(typeof tiny.reachedAt, 'number');
	});

	it('fits the least recently fitted population first, so a stopped run resumes where it left off', async () => {
		const p = (population, lastFittedAt) => ({ head: { population }, lastFittedAt });
		assert.deepStrictEqual(
			processingOrder([p('b', 20), p('c'), p('a', 10), p('d', 20)]).map((x) => x.head.population),
			['c', 'a', 'b', 'd']
		);
		await recordCases(models, 0, 40);
		const first = await models.calibrate();
		assert.strictEqual(first.processed, 1);
		await recordCases(models, 100, 40, { instructions: 'second population' });
		// A run stopped by its deadline right after discovery leaves both pending; neither is lost.
		let clock = Date.now();
		let reads = 0;
		const stopped = await runCalibration({ maxRunMs: 1_000 }, { now: () => (reads++ < 1 ? clock : clock + 10_000) });
		assert.strictEqual(stopped.stoppedBy, 'maxRunMs');
		assert.strictEqual(stopped.processed, 0);
		const resumed = await models.calibrate();
		assert.strictEqual(resumed.processed, 2, 'the next run covers both, the never-fitted one first');
	});

	it('resolves an unexpected fault as a failed run, with no unhandled rejection', async () => {
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const run = await runCalibration(
				{},
				{
					now: () => {
						throw new Error('clock failed at /private/path');
					},
				}
			);
			assert.strictEqual(run.status, 'failed');
			assert.match(run.error, /unexpected fault/);
			const next = await runCalibration();
			assert.strictEqual(next.status, 'completed', 'the queue keeps running after a failed run');
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('reaches an older population past the decision budget within a few runs', async () => {
		await recordCases(models, 0, 25, { instructions: 'older population' });
		await recordCases(models, 100, 50);
		for (let i = 0; i < 8 && (await knownInstructions()).size < 2; i++) await runCalibration({ maxDecisions: 40 });
		assert.strictEqual((await knownInstructions()).size, 2, 'both populations were reached');
	});

	it('does not let a read started before an invalidation repopulate the cache', async () => {
		let reads = 0;
		let release;
		setCalibrationReadForTests(() => {
			reads++;
			return new Promise((resolve) => (release = resolve));
		});
		resetCalibrationCache();
		await models.decide('case-1', SCHEMA);
		assert.strictEqual(reads, 1);
		resetCalibrationCache();
		release(null);
		await waitFor(() => outstandingCalibrationReads() === 0, 'the stale read to settle');
		setCalibrationReadForTests(() => {
			reads++;
			return Promise.resolve(null);
		});
		await models.decide('case-2', SCHEMA);
		assert.strictEqual(reads, 2, 'the stale result was discarded, so the next decision loads again');
	});

	it('reports a run as failed when any population could not be processed', async () => {
		await recordCases(models, 0, 30);
		const { outcomes } = getDecisionTables();
		const get = outcomes.get;
		outcomes.get = function () {
			throw new Error('outcome read failed');
		};
		try {
			const run = await models.calibrate();
			assert.strictEqual(run.failed, 1);
			assert.strictEqual(run.status, 'failed');
			assert.match(run.error, /1 population/);
		} finally {
			outcomes.get = get;
		}
	});

	it('makes progress through the table even with a budget of two decisions', async () => {
		await recordCases(models, 0, 20, { instructions: 'older population' });
		await recordCases(models, 100, 20);
		for (let i = 0; i < 40 && (await knownInstructions()).size < 2; i++) {
			const run = await runCalibration({ maxDecisions: 2 });
			assert.strictEqual(run.scanned, 1);
		}
		assert.strictEqual((await knownInstructions()).size, 2, 'the older population was reached');
	});

	it('fits every population under a population budget of one, across runs', async () => {
		await recordCases(models, 0, 30, { instructions: 'older population' });
		await recordCases(models, 100, 30);
		for (let i = 0; i < 4 && (await models.getCalibrations()).length < 2; i++)
			await runCalibration({ maxPopulations: 1 });
		assert.strictEqual((await models.getCalibrations()).length, 2);
	});

	it('counts decisions read for fitting against the run budget', async () => {
		await recordCases(models, 0, 30);
		const run = await runCalibration({ maxDecisions: 20, maxExamplesPerKey: 10 });
		assert.strictEqual(run.scanned, 10);
		assert.strictEqual(run.read, 10, 'fitting reads only what discovery left');
		const short = await runCalibration({ maxDecisions: 20 });
		assert.strictEqual(
			short.written,
			0,
			'a population cut short by the budget is deferred, not fitted from a truncated read'
		);
		assert.strictEqual(short.stoppedBy, 'maxDecisions');
		assert.ok(short.pending >= 1);
	});

	it('fits a small population under a budget far below the sample ceiling', async () => {
		await recordCases(models, 0, 25);
		const run = await runCalibration({ maxDecisions: 60 });
		assert.strictEqual(run.read, 25, 'the whole population fits what is left');
		assert.strictEqual(run.written, 1);
	});

	it('never revokes a fit from a sample truncated by the decision budget', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		assert.strictEqual((await warmDecide(models, 'case-1400')).calibrated, true);
		const low = await runCalibration({ maxDecisions: 40 });
		assert.strictEqual(low.written, 0, 'nothing is written from a partial read');
		resetCalibrationCache();
		assert.strictEqual((await warmDecide(models, 'case-1401')).calibrated, true, 'the fit still applies');
	});

	it('never reads a discovery page larger than the budget left', async () => {
		await recordCases(models, 0, 30);
		const { decisions } = getDecisionTables();
		const search = decisions.search;
		const limits = [];
		decisions.search = function (request) {
			if (request?.conditions?.[0]?.attribute === 'expiresAt') limits.push(request.limit);
			return search.call(this, request);
		};
		try {
			await runCalibration({ maxDecisions: 4 });
		} finally {
			decisions.search = search;
		}
		assert.ok(limits.length > 0);
		assert.ok(
			limits.every((limit) => limit <= 3),
			`page limits ${limits}`
		);
	});

	it('moves a population too large for this run to the back, so smaller ones behind it are fitted', async () => {
		await recordCases(models, 0, 300, { instructions: 'large population' });
		await recordCases(models, 1000, 30);
		for (let i = 0; i < 4 && (await models.getCalibrations()).length < 1; i++)
			await runCalibration({ maxDecisions: 100 });
		const fitted = await models.getCalibrations();
		assert.strictEqual(fitted.length, 1, 'the small population was fitted');
		assert.strictEqual(fitted[0].instructionsHash, undefined);
	});

	it('fits a population whose size exactly matches what the budget leaves', async () => {
		await recordCases(models, 0, 30);
		const run = await runCalibration({ maxDecisions: 60 });
		assert.strictEqual(run.scanned, 30, 'discovery read the whole table');
		assert.strictEqual(run.read, 30, 'the population fits exactly what is left');
		assert.strictEqual(run.written, 1);
	});

	it('keeps the job and cache on an unchanged reload on the primary worker too', async () => {
		const engine = require('#src/resources/scheduler/engine');
		const owner = engine.internalJobOwner('models-calibration');
		try {
			configureCalibration(CONFIG, true);
			assert.deepStrictEqual(engine.getRegisteredJobNames(owner), ['calibrate']);
			await recordCases(models, 0, 300);
			await models.calibrate();
			assert.strictEqual((await warmDecide(models, 'case-1700')).calibrated, true);
			configureCalibration({ ...CONFIG }, true);
			assert.strictEqual((await models.decide('case-1701', SCHEMA)).calibrated, true, 'the reload returned early');
			assert.deepStrictEqual(engine.getRegisteredJobNames(owner), ['calibrate']);
		} finally {
			configureCalibration(undefined, true);
			engine.stopSchedulerEngine();
		}
		assert.deepStrictEqual(engine.getRegisteredJobNames(owner), [], 'removing the block unregisters the job');
	});

	it('returns early when a reload leaves calibration unchanged, keeping its cache and its job', async () => {
		await recordCases(models, 0, 300);
		await models.calibrate();
		assert.strictEqual((await warmDecide(models, 'case-1500')).calibrated, true);
		configureCalibration({ ...CONFIG }, false);
		assert.strictEqual(
			(await models.decide('case-1501', SCHEMA)).calibrated,
			true,
			'an unchanged reload does not reset anything'
		);
		configureCalibration({ ...CONFIG, eceMargin: 0.02 }, false);
		assert.strictEqual((await models.decide('case-1502', SCHEMA)).calibrated, false, 'a changed one does');
	});

	it('makes progress one decision at a time', async () => {
		await recordCases(models, 0, 20, { instructions: 'older population' });
		await recordCases(models, 100, 5);
		for (let i = 0; i < 40 && (await knownInstructions()).size < 2; i++) await runCalibration({ maxDecisions: 1 });
		assert.strictEqual((await knownInstructions()).size, 2);
	});

	it('survives a population row with no schema, in runs and in listing', async () => {
		await recordCases(models, 0, 30);
		await models.calibrate();
		const tbl = getCalibrationsTable();
		await transaction({}, () =>
			tbl.put({
				id: 'population/empty',
				kind: 'population',
				population: 'empty',
				owner: 'none',
				lastFittedAt: 0,
				expiresAt: Date.now() + 86_400_000,
			})
		);
		const run = await models.calibrate();
		assert.ok(run.processed >= 1, 'the other populations are still processed');
		assert.strictEqual(run.failed, 1);
		const listed = await models.getCalibrations();
		assert.strictEqual(listed.length, 1, 'listing skips the malformed row');
	});

	it('fails the scheduled job when its run fails', async () => {
		await recordCases(models, 0, 30);
		const { outcomes } = getDecisionTables();
		const get = outcomes.get;
		outcomes.get = function () {
			throw new Error('outcome read failed');
		};
		try {
			await assert.rejects(calibrationJob(), /calibration run failed/);
		} finally {
			outcomes.get = get;
		}
	});

	it('lets a correction revoke a fit even when its facts carry an older time', async () => {
		const ids = await recordCases(models, 0, 300);
		await models.calibrate();
		assert.strictEqual((await warmDecide(models, 'case-1300')).calibrated, true);
		const { outcomes } = getDecisionTables();
		await transaction({}, async () => {
			for (const id of ids)
				await outcomes.put({
					id: `${id}/truth`,
					decisionId: id,
					fact: 'truth',
					state: { kind: 'unknown' },
					at: 1,
					expiresAt: Date.now() + 86_400_000,
				});
		});
		const run = await models.calibrate();
		assert.strictEqual(run.written, 1);
		resetCalibrationCache();
		assert.strictEqual((await warmDecide(models, 'case-1301')).calibrated, false, 'the skewed correction still wins');
	});

	it('reports a population whose schema has a no-match leaf, and says why it is not applied', async () => {
		const NM = { enum: VALUES, noMatch: true };
		setDecision(
			'default',
			defineBackend({
				name: 'nomatch',
				noMatch: true,
				decide: async (state) => ({
					status: 'completed',
					output: { distribution: distributionFor(state), noMatch: 0.1, signature: SIGNATURE },
				}),
			})
		);
		for (let i = 0; i < 300; i++) {
			const d = await models.decide(`case-${i}`, NM, { persist: true });
			await models.recordOutcome(d.id, { truth: { kind: 'value', value: truthOf(i) } });
		}
		await models.calibrate();
		const [summary] = await models.getCalibrations();
		assert.strictEqual(summary.eligible, false);
		assert.strictEqual(summary.applied, false);
		assert.strictEqual(summary.reason, 'no-match-schema');
		assert.ok(summary.report.raw, 'its reliability is still reported');
	});

	it('lets a run lower its budgets but never raise them, and ignores invalid ones', async () => {
		configureCalibration({ ...CONFIG, maxDecisions: 10 }, false);
		await recordCases(models, 0, 30);
		assert.strictEqual((await runCalibration({ maxDecisions: 1000 })).scanned, 5);
		assert.strictEqual((await runCalibration({ maxDecisions: 4 })).scanned, 2);
		assert.strictEqual((await runCalibration({ maxDecisions: '2', maxRunMs: 'x' })).scanned, 5);
	});

	it('contains a malformed population row and moves it to the back', async () => {
		await recordCases(models, 0, 30);
		await models.calibrate();
		const tbl = getCalibrationsTable();
		const bad = {
			id: 'population/bad',
			kind: 'population',
			population: 'bad',
			owner: 'none',
			schema: 42,
			lastFittedAt: 0,
			expiresAt: Date.now() + 86_400_000,
		};
		await transaction({}, () => tbl.put(bad));
		const run = await models.calibrate();
		assert.strictEqual(run.failed, 1);
		assert.strictEqual(run.status, 'failed');
		const after = await transaction({}, () => tbl.get('population/bad'));
		assert.ok(after.lastFittedAt > 0, 'it rotates to the back instead of blocking every run');
	});

	it('reports a discovery failure as a failed run and still processes known populations', async () => {
		await recordCases(models, 0, 40);
		await models.calibrate();
		const { decisions } = getDecisionTables();
		const search = decisions.search;
		let first = true;
		decisions.search = function (request) {
			if (first && request?.conditions?.[0]?.attribute === 'expiresAt') {
				first = false;
				throw new Error('index unavailable at /private/path');
			}
			return search.call(this, request);
		};
		try {
			await models.recordOutcome((await models.decide('case-9000', SCHEMA, { persist: true })).id, {
				truth: { kind: 'value', value: truthOf(9000) },
			});
			const run = await models.calibrate();
			assert.strictEqual(run.status, 'failed');
			assert.match(run.error, /discovering populations/);
			assert.strictEqual(run.processed, 1, 'the known population is still processed');
		} finally {
			decisions.search = search;
		}
	});
});
