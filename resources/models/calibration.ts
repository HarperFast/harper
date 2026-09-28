import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { canonicalJson } from './decision.ts';
import type { DecisionOutcome } from './types.ts';

export const SELECTIVE_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95] as const;
const ECE_BINS = 10;
const SCORED_EPSILON = 1e-9;
const DEFAULT_VOTE_SAMPLES = 5;
const WILSON_Z = 1.96;
const GOLDEN_ITERATIONS = 60;
export const MIN_TEMPERATURE = 0.05;
export const MAX_TEMPERATURE = 20;
/** The `truth` of an example whose recorded truth is `noMatch`: counted by operational risk only. */
export const NO_MATCH_TRUTH = -1;

export interface CalibrationParams {
	t: number;
	epsilon: number;
}

export interface Example {
	probabilities: number[];
	truth: number;
}

export interface SelectivePoint {
	threshold: number;
	count: number;
	coverage: number;
	risk: number | null;
	riskUpper: number | null;
}

export interface ReliabilityBin {
	count: number;
	confidence: number | null;
	accuracy: number | null;
}

export interface Reliability {
	ece: number;
	nll: number;
	bins: ReliabilityBin[];
	/** Among examples whose truth is an allowed value: the population a fit is trained on. */
	conditional: SelectivePoint[];
	/** Among all examples, where a `noMatch` truth above the threshold counts as an error. */
	operational: SelectivePoint[];
}

/** What produced a decision's scores and whose outcomes it answers to; any change is a new population. */
export interface Population {
	tenant?: string;
	app?: string;
	model: string;
	entry: string;
	signature: string;
	instructionsHash?: string;
	schemaHash: string;
}

export interface FitPolicy {
	minReport: number;
	minTrain: number;
	minHeldOut: number;
	heldOutShare: number;
	eceMargin: number;
	maxAgeMs: number;
}

function digest(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function populationKey(population: Population): string {
	return digest({
		tenant: population.tenant ?? null,
		app: population.app ?? null,
		model: population.model,
		entry: population.entry,
		signature: population.signature,
		instructionsHash: population.instructionsHash ?? null,
		schemaHash: population.schemaHash,
	});
}

/** Orders a population's decisions newest first under one indexed prefix, so a run reads only the newest it needs. */
export function populationRank(population: string, expiresAt: number, id: string): string {
	return `${population}|${String(Math.max(0, Math.floor(expiresAt))).padStart(16, '0')}|${id}`;
}

export function calibrationKey(population: string, field: string | undefined): string {
	return digest({ population, field: field ?? null });
}

/** Identical inputs, policy and result give an identical id, so a repeated run writes nothing new. */
export function fitId(key: string, inputDigest: string, policy: FitPolicy, result: object): string {
	return digest({ key, inputDigest, policy, result });
}

export function policyDigest(policy: FitPolicy): string {
	return digest(policy);
}

export function inputDigester(): { add(part: unknown): void; digest(): string } {
	const hash = createHash('sha256');
	return {
		add(part: unknown) {
			hash.update(canonicalJson(part));
			hash.update('\n');
		},
		digest: () => hash.digest('hex'),
	};
}

/**
 * Smoothing mass for a distribution: half a vote per value for a voted distribution, so a value no
 * sample chose keeps a finite log; a numerical guard otherwise.
 */
export function smoothingEpsilon(signature: string | undefined): number {
	if (!signature || !/(^|;)mode=vote(;|$)/.test(signature)) return SCORED_EPSILON;
	const samples = Number(/(?:^|;)samples=(\d+)(?:;|$)/.exec(signature)?.[1]);
	return 0.5 / (Number.isInteger(samples) && samples > 0 ? samples : DEFAULT_VOTE_SAMPLES);
}

/** A replicated row is not trusted to be well formed. */
export function isValidParams(params: unknown): params is CalibrationParams {
	if (!params || typeof params !== 'object') return false;
	const { t, epsilon } = params as { t?: unknown; epsilon?: unknown };
	return (
		typeof t === 'number' &&
		Number.isFinite(t) &&
		t >= MIN_TEMPERATURE &&
		t <= MAX_TEMPERATURE &&
		typeof epsilon === 'number' &&
		Number.isFinite(epsilon) &&
		epsilon > 0 &&
		epsilon < 1
	);
}

/** Strictly increasing in each value's raw score, so ties stay tied and the winner never moves. */
export function applyCalibration(probabilities: number[], params: CalibrationParams): number[] {
	const k = probabilities.length;
	const inverse = 1 / params.t;
	const logs = new Array<number>(k);
	let max = -Infinity;
	for (let i = 0; i < k; i++) {
		logs[i] = Math.log((Math.max(0, probabilities[i]) + params.epsilon) / (1 + k * params.epsilon)) * inverse;
		if (logs[i] > max) max = logs[i];
	}
	let total = 0;
	for (let i = 0; i < k; i++) {
		logs[i] = Math.exp(logs[i] - max);
		total += logs[i];
	}
	for (let i = 0; i < k; i++) logs[i] /= total;
	return logs;
}

function meanNll(examples: Example[], params: CalibrationParams): number {
	let total = 0;
	for (const example of examples) {
		total -= Math.log(Math.max(applyCalibration(example.probabilities, params)[example.truth], 1e-15));
	}
	return total / examples.length;
}

/**
 * The temperature minimizing negative log-likelihood on `train` (examples with an allowed-value truth),
 * by golden-section search over `log t`. Yields between iterations; undefined when `deadline` passes first.
 */
export async function fitCalibration(
	train: Example[],
	epsilon: number,
	deadline: number,
	now: () => number = Date.now
): Promise<CalibrationParams | undefined> {
	const f = (x: number) => meanNll(train, { t: Math.exp(x), epsilon });
	const ratio = (Math.sqrt(5) - 1) / 2;
	let a = Math.log(MIN_TEMPERATURE);
	let b = Math.log(MAX_TEMPERATURE);
	let c = b - ratio * (b - a);
	let d = a + ratio * (b - a);
	let fc = f(c);
	let fd = f(d);
	for (let i = 0; i < GOLDEN_ITERATIONS; i++) {
		await yieldToEventLoop();
		if (now() >= deadline) return undefined;
		if (fc < fd) {
			b = d;
			d = c;
			fd = fc;
			c = b - ratio * (b - a);
			fc = f(c);
		} else {
			a = c;
			c = d;
			fc = fd;
			d = a + ratio * (b - a);
			fd = f(d);
		}
	}
	return { t: Math.exp((a + b) / 2), epsilon };
}

function argmax(p: number[]): number {
	let top = 0;
	for (let i = 1; i < p.length; i++) if (p[i] > p[top]) top = i;
	return top;
}

export function wilsonUpper(errors: number, count: number): number | null {
	if (count === 0) return null;
	const p = errors / count;
	const z2 = WILSON_Z * WILSON_Z;
	const centre = p + z2 / (2 * count);
	const margin = WILSON_Z * Math.sqrt((p * (1 - p)) / count + z2 / (4 * count * count));
	return Math.min(1, (centre + margin) / (1 + z2 / count));
}

function selective(tops: Array<{ confidence: number; correct: boolean }>, total: number): SelectivePoint[] {
	return SELECTIVE_THRESHOLDS.map((threshold) => {
		let count = 0;
		let errors = 0;
		for (const top of tops) {
			if (top.confidence < threshold) continue;
			count++;
			if (!top.correct) errors++;
		}
		return {
			threshold,
			count,
			coverage: total ? count / total : 0,
			risk: count ? errors / count : null,
			riskUpper: wilsonUpper(errors, count),
		};
	});
}

export function reliability(examples: Example[], transform: (p: number[]) => number[]): Reliability {
	const sums = Array.from({ length: ECE_BINS }, () => ({ count: 0, confidence: 0, correct: 0 }));
	const inSet: Array<{ confidence: number; correct: boolean }> = [];
	const all: Array<{ confidence: number; correct: boolean }> = [];
	let nll = 0;
	for (const example of examples) {
		const p = transform(example.probabilities);
		const top = argmax(p);
		const confidence = p[top];
		if (example.truth === NO_MATCH_TRUTH) {
			all.push({ confidence, correct: false });
			continue;
		}
		const correct = top === example.truth;
		const bin = sums[Math.min(ECE_BINS - 1, Math.floor(confidence * ECE_BINS))];
		bin.count++;
		bin.confidence += confidence;
		bin.correct += correct ? 1 : 0;
		inSet.push({ confidence, correct });
		all.push({ confidence, correct });
		nll -= Math.log(Math.max(p[example.truth], 1e-15));
	}
	const n = inSet.length;
	let ece = 0;
	for (const bin of sums) if (bin.count && n) ece += Math.abs(bin.confidence - bin.correct) / n;
	return {
		ece,
		nll: n ? nll / n : 0,
		bins: sums.map(({ count, confidence, correct }) => ({
			count,
			confidence: count ? confidence / count : null,
			accuracy: count ? correct / count : null,
		})),
		conditional: selective(inSet, n),
		operational: selective(all, all.length),
	};
}

/** Oldest first; the newest `heldOutShare` is held out, so a refit is judged on decisions newer than any it trained on. */
export function splitByTime<E>(ordered: E[], heldOutShare: number): { train: E[]; heldOut: E[] } {
	const heldOutCount = Math.floor(ordered.length * heldOutShare);
	return {
		train: ordered.slice(0, ordered.length - heldOutCount),
		heldOut: ordered.slice(ordered.length - heldOutCount),
	};
}

export function toVector(
	distribution: DecisionOutcome[] | undefined,
	values: readonly unknown[]
): number[] | undefined {
	if (!Array.isArray(distribution)) return undefined;
	const byValue = new Map(distribution.map((entry) => [canonicalJson(entry.value), entry.probability]));
	const vector = values.map((value) => byValue.get(canonicalJson(value)));
	return vector.every((p) => typeof p === 'number' && Number.isFinite(p)) ? (vector as number[]) : undefined;
}
