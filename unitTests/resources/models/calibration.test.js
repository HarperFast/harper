'use strict';

const assert = require('node:assert');
const {
	applyCalibration,
	calibrationKey,
	fitCalibration,
	fitId,
	inputDigester,
	isValidParams,
	NO_MATCH_TRUTH,
	populationKey,
	reliability,
	smoothingEpsilon,
	splitByTime,
	toVector,
	wilsonUpper,
} = require('#src/resources/models/calibration');

// A deterministic generator, so the synthetic populations are the same on every run.
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** A three-way scorer whose top value is the truth 60% of the time but always reports it at 0.9. */
function overconfident(n, seed) {
	const random = rng(seed);
	const examples = [];
	for (let i = 0; i < n; i++) {
		const truth = Math.floor(random() * 3);
		const top = random() < 0.6 ? truth : (truth + 1 + Math.floor(random() * 2)) % 3;
		const probabilities = [0.05, 0.05, 0.05];
		probabilities[top] = 0.9;
		examples.push({ probabilities, truth });
	}
	return examples;
}

const identity = (p) => p;
const FAR = Number.MAX_SAFE_INTEGER;

describe('calibration population and keys', () => {
	const base = {
		model: 'default',
		entry: 'e1',
		signature: 'generative=default;mode=score;samples=5;temperature=default;source=s1',
		instructionsHash: undefined,
		schemaHash: 's1',
	};

	it('is stable for the same population and changes with every part of it', () => {
		assert.strictEqual(populationKey(base), populationKey({ ...base }));
		for (const [part, value] of [
			['tenant', 't1'],
			['model', 'triage'],
			['entry', 'e2'],
			['signature', 'generative=default;mode=score;samples=5;temperature=default;source=s2'],
			['instructionsHash', 'i1'],
			['schemaHash', 's2'],
		])
			assert.notStrictEqual(populationKey({ ...base, [part]: value }), populationKey(base), part);
	});

	it('keys each field of a population separately', () => {
		const population = populationKey(base);
		assert.notStrictEqual(calibrationKey(population, 'route'), calibrationKey(population, undefined));
		assert.notStrictEqual(calibrationKey(population, 'route'), calibrationKey(population, 'urgent'));
	});
});

describe('calibration smoothing and fitting', () => {
	it('smooths a voted distribution by half a vote and a scored one by a numerical guard only', () => {
		assert.strictEqual(smoothingEpsilon('generative=default;mode=vote;samples=10;temperature=default'), 0.05);
		assert.strictEqual(smoothingEpsilon('generative=default;mode=vote;temperature=default'), 0.1);
		assert.strictEqual(smoothingEpsilon('generative=default;mode=score;samples=10;temperature=default'), 1e-9);
		assert.strictEqual(smoothingEpsilon(undefined), 1e-9);
	});

	it('keeps every calibrated value finite for a vote distribution with exact zeros', async () => {
		const params = await fitCalibration(
			[
				{ probabilities: [1, 0, 0], truth: 0 },
				{ probabilities: [0.8, 0.2, 0], truth: 1 },
				{ probabilities: [0, 1, 0], truth: 1 },
			],
			smoothingEpsilon('generative=default;mode=vote;samples=5;temperature=default'),
			FAR
		);
		for (const p of applyCalibration([1, 0, 0], params)) assert.ok(Number.isFinite(p) && p > 0);
	});

	it('lowers held-out calibration error for an overconfident scorer and never moves the top value', async () => {
		const train = overconfident(400, 1);
		const heldOut = overconfident(200, 2);
		const params = await fitCalibration(train, 1e-9, FAR);
		assert.ok(params.t > 1, `an overconfident scorer is softened (t=${params.t})`);
		const calibrate = (p) => applyCalibration(p, params);
		const raw = reliability(heldOut, identity);
		const calibrated = reliability(heldOut, calibrate);
		assert.ok(calibrated.ece < raw.ece, `ece ${calibrated.ece} < ${raw.ece}`);
		assert.ok(calibrated.nll < raw.nll, `nll ${calibrated.nll} < ${raw.nll}`);
		for (const { probabilities } of heldOut) {
			const out = calibrate(probabilities);
			assert.strictEqual(out.indexOf(Math.max(...out)), probabilities.indexOf(Math.max(...probabilities)));
			assert.ok(Math.abs(out.reduce((s, x) => s + x, 0) - 1) < 1e-9);
		}
	});

	it('gives up at the deadline instead of finishing the search', async () => {
		let clock = 0;
		const params = await fitCalibration(overconfident(50, 3), 1e-9, 5, () => clock++);
		assert.strictEqual(params, undefined);
	});

	it('yields to the event loop while it fits', async () => {
		let ticks = 0;
		const timer = setInterval(() => ticks++, 0);
		try {
			await fitCalibration(overconfident(2000, 4), 1e-9, FAR);
		} finally {
			clearInterval(timer);
		}
		assert.ok(ticks > 0, 'timers ran during the fit');
	});

	it('keeps tied values tied and never moves a binary winner', () => {
		const tied = applyCalibration([0.4, 0.4, 0.2], { t: 2.5, epsilon: 1e-9 });
		assert.strictEqual(tied[0], tied[1]);
		for (const t of [0.05, 0.5, 1, 3, 20]) {
			const out = applyCalibration([0.7, 0.3], { t, epsilon: 1e-9 });
			assert.ok(out[0] > out[1], `t=${t}`);
		}
	});
});

describe('reliability report', () => {
	it('reports coverage, risk and its upper bound at each threshold', () => {
		const examples = [
			{ probabilities: [0.95, 0.05], truth: 0 },
			{ probabilities: [0.95, 0.05], truth: 1 },
			{ probabilities: [0.55, 0.45], truth: 0 },
			{ probabilities: [0.55, 0.45], truth: 0 },
		];
		const { conditional } = reliability(examples, identity);
		const at = (t) => conditional.find((s) => s.threshold === t);
		assert.deepStrictEqual(
			{ ...at(0.5), riskUpper: undefined },
			{ threshold: 0.5, count: 4, coverage: 1, risk: 0.25, riskUpper: undefined }
		);
		assert.ok(at(0.5).riskUpper > 0.25 && at(0.5).riskUpper < 1);
		assert.deepStrictEqual(
			{ ...at(0.9), riskUpper: undefined },
			{ threshold: 0.9, count: 2, coverage: 0.5, risk: 0.5, riskUpper: undefined }
		);
		const none = reliability([{ probabilities: [0.55, 0.45], truth: 0 }], identity).conditional.find(
			(s) => s.threshold === 0.9
		);
		assert.deepStrictEqual(none, { threshold: 0.9, count: 0, coverage: 0, risk: null, riskUpper: null });
	});

	it('counts an accepted no-match truth as an error operationally but not conditionally', () => {
		const examples = [];
		for (let i = 0; i < 70; i++) examples.push({ probabilities: [0.95, 0.05], truth: 0 });
		for (let i = 0; i < 30; i++) examples.push({ probabilities: [0.95, 0.05], truth: NO_MATCH_TRUTH });
		const report = reliability(examples, identity);
		const conditional = report.conditional.find((s) => s.threshold === 0.9);
		const operational = report.operational.find((s) => s.threshold === 0.9);
		assert.strictEqual(conditional.risk, 0);
		assert.strictEqual(conditional.count, 70);
		assert.strictEqual(operational.risk, 0.3);
		assert.strictEqual(operational.count, 100);
		assert.ok(Number.isFinite(report.nll), 'a no-match truth is left out of the likelihood');
	});

	it('bounds an error rate by the Wilson interval, narrowing as the count grows', () => {
		assert.strictEqual(wilsonUpper(0, 0), null);
		const small = wilsonUpper(0, 10);
		const large = wilsonUpper(0, 1000);
		assert.ok(small > 0.2 && small < 0.35, `0 of 10: ${small}`);
		assert.ok(large < 0.005, `0 of 1000: ${large}`);
		assert.ok(wilsonUpper(10, 100) > 0.1);
		assert.strictEqual(wilsonUpper(5, 5), 1);
	});

	it('reads a stored distribution back in schema order', () => {
		assert.deepStrictEqual(
			toVector(
				[
					{ value: 'bug', probability: 0.7 },
					{ value: 'billing', probability: 0.2 },
					{ value: 'refund', probability: 0.1 },
				],
				['billing', 'refund', 'bug']
			),
			[0.2, 0.1, 0.7]
		);
		assert.strictEqual(toVector([{ value: 'bug', probability: 1 }], ['bug', 'refund']), undefined);
	});
});

describe('windows and fit identity', () => {
	it('holds out the newest examples of an oldest-first list', () => {
		const examples = Array.from({ length: 10 }, (_, i) => ({ at: 91 + i }));
		const { train, heldOut } = splitByTime(examples, 0.3);
		assert.deepStrictEqual(
			heldOut.map((e) => e.at),
			[98, 99, 100]
		);
		assert.strictEqual(train.length, 7);
	});

	it('names a version by its inputs, policy and result', () => {
		const policy = { minReport: 20, minTrain: 100, minHeldOut: 100, heldOutShare: 0.3, eceMargin: 0.01, maxAgeMs: 1 };
		const result = { t: 2, epsilon: 1e-9, eligible: true, reason: null };
		const id = fitId('k', 'd1', policy, result);
		assert.strictEqual(id, fitId('k', 'd1', { ...policy }, { ...result }));
		assert.notStrictEqual(fitId('k', 'd2', policy, result), id, 'inputs');
		assert.notStrictEqual(fitId('k', 'd1', { ...policy, minTrain: 200 }, result), id, 'policy');
		assert.notStrictEqual(fitId('k', 'd1', policy, { ...result, eligible: false }), id, 'result');
	});

	it('digests inputs in order, so any change to an example or its truth changes the digest', () => {
		const digest = (parts) => {
			const d = inputDigester();
			for (const part of parts) d.add(part);
			return d.digest();
		};
		const base = [
			['a', [0.9, 0.1], { kind: 'value', value: 'x' }, 5],
			['b', [0.2, 0.8], null, null],
		];
		assert.strictEqual(digest(base), digest(base.map((p) => [...p])));
		assert.notStrictEqual(digest([base[0], ['b', [0.2, 0.8], { kind: 'unknown' }, 9]]), digest(base));
		assert.notStrictEqual(digest([base[1], base[0]]), digest(base));
	});

	it('rejects malformed loaded parameters', () => {
		assert.ok(isValidParams({ t: 2, epsilon: 1e-9 }));
		for (const bad of [
			null,
			{},
			{ t: NaN, epsilon: 1e-9 },
			{ t: 0, epsilon: 1e-9 },
			{ t: 2, epsilon: 0 },
			{ t: 50, epsilon: 1e-9 },
		])
			assert.ok(!isValidParams(bad), JSON.stringify(bad));
	});
});
