import { getDatabases, isReadOnlyMode, table } from '../databases.ts';
import { contextStorage, transaction } from '../transaction.ts';
import type { Context } from '../ResourceInterface.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { isApplicationPrimaryWorker } from '../../server/threads/manageThreads.js';
import { recordAction } from '../analytics/write.ts';
import {
	internalJobOwner,
	registerInternalJobs,
	safeErrorMessage,
	startSchedulerEngine,
	unregisterInternalJobs,
} from '../scheduler/engine.ts';
import { allowedValues, canonicalJson, isObjectSchema } from './decision.ts';
import { DECISION_RETENTION_MS, getDecisionTables, truthKey, type DecisionRow } from './decisionStore.ts';
import {
	applyCalibration,
	calibrationKey,
	type CalibrationParams,
	type Example,
	type FitPolicy,
	fitCalibration,
	fitId,
	inputDigester,
	isValidParams,
	NO_MATCH_TRUTH,
	type Population,
	policyDigest,
	type Reliability,
	reliability,
	smoothingEpsilon,
	splitByTime,
	toVector,
} from './calibration.ts';
import type { Decision, DecisionLeaf, DecisionOutcome, DecisionSchema, FieldDecision, OutcomeTruth } from './types.ts';

const log = harperLogger.forComponent('models').conditional;

export const CALIBRATIONS_TABLE = 'hdb_model_calibrations';
const JOB_NAME = 'models-calibration';
const CACHE_LIMIT = 1024;
const CACHE_FRESH_MS = 60_000;
const LOAD_TIMEOUT_MS = 2_000;
const FAULT_LOG_INTERVAL_MS = 60_000;
const SCAN_PAGE = 500;
const YIELD_EVERY = 500;
const EXAMPLE_OVERHEAD_BYTES = 200;
const POPULATION_OVERHEAD_BYTES = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RANK_WIDTH = 16;
const CURSOR_ID = 'discovery/cursor';

export interface CalibrationConfig {
	interval?: number;
	maxDecisions?: number;
	maxPopulations?: number;
	maxExamplesPerKey?: number;
	maxBytes?: number;
	maxLoads?: number;
	maxRunMs?: number;
	minReport?: number;
	minTrain?: number;
	minHeldOut?: number;
	heldOutShare?: number;
	eceMargin?: number;
	maxAgeMs?: number;
}

type Settings = Required<CalibrationConfig>;

/** What a single run may override: its budgets. The fit policy always comes from configuration. */
export type CalibrationBudgets = Pick<
	CalibrationConfig,
	'maxDecisions' | 'maxPopulations' | 'maxExamplesPerKey' | 'maxBytes' | 'maxRunMs'
>;

const BUDGET_KEYS = ['maxDecisions', 'maxPopulations', 'maxExamplesPerKey', 'maxBytes', 'maxRunMs'] as const;

function budgetsOnly(budgets: CalibrationBudgets, configured: Settings): CalibrationBudgets {
	const out: CalibrationBudgets = {};
	for (const key of BUDGET_KEYS) {
		const value = budgets?.[key];
		if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
			out[key] = Math.min(value, configured[key]);
	}
	return out;
}

const DEFAULTS: Settings = {
	interval: DAY_MS,
	maxDecisions: 100_000,
	maxPopulations: 1_000,
	maxExamplesPerKey: 5_000,
	maxBytes: 64 * 1024 * 1024,
	maxLoads: 8,
	maxRunMs: 60_000,
	minReport: 20,
	minTrain: 100,
	minHeldOut: 100,
	heldOutShare: 0.3,
	eceMargin: 0.01,
	maxAgeMs: 30 * DAY_MS,
};

export interface CalibrationReport {
	/** `heldOut` when a fit was evaluated; `all` when there were too few labels to fit, so every labelled decision is described. */
	window: 'heldOut' | 'all';
	labelled: number;
	noMatchCount: number;
	trainCount: number;
	heldOutCount: number;
	raw: Reliability;
	calibrated?: Reliability;
}

export interface CalibrationRow extends Population {
	id: string;
	kind: 'fit';
	key: string;
	rank: string;
	population: string;
	field?: string;
	t: number;
	epsilon: number;
	cutoff: number;
	evidenceAt: number;
	fittedAt: number;
	applyUntil: number;
	expiresAt: number;
	eligible: boolean;
	reason?: 'too-few-labels' | 'no-improvement' | 'no-match-schema';
	policy: FitPolicy;
	policyDigest: string;
	inputDigest: string;
	decisions: number;
	labelled: number;
	report?: CalibrationReport;
}

/** One row per population, rewritten each time it is processed: what a run needs to revisit it. */
interface PopulationHead extends Population {
	id: string;
	kind: 'population';
	population: string;
	owner: string;
	schema: DecisionSchema;
	lastFittedAt: number;
	expiresAt: number;
}

export interface CalibrationRunResult {
	status: 'completed' | 'failed';
	error?: string;
	scanned: number;
	discovered: number;
	processed: number;
	pending: number;
	written: number;
	eligible: number;
	skipped: number;
	failed: number;
	stoppedBy?: 'maxDecisions' | 'maxPopulations' | 'maxRunMs' | 'maxBytes';
	reachedAt?: number;
	durationMs: number;
}

export interface CalibrationSummary {
	model: string;
	field?: string;
	signature: string;
	instructionsHash?: string;
	schemaHash: string;
	fittedAt: number;
	applyUntil: number;
	eligible: boolean;
	applied: boolean;
	reason?: string;
	decisions: number;
	labelled: number;
	t: number;
	report?: CalibrationReport;
}

export const CALIBRATION_ATTRIBUTES = [
	{ name: 'id', isPrimaryKey: true },
	{ name: 'kind', type: 'string', indexed: true },
	{ name: 'key', type: 'string' },
	{ name: 'rank', type: 'string', indexed: true },
	{ name: 'population', type: 'string' },
	{ name: 'field', type: 'string' },
	{ name: 'tenant', type: 'string' },
	{ name: 'app', type: 'string' },
	{ name: 'model', type: 'string' },
	{ name: 'entry', type: 'string' },
	{ name: 'signature', type: 'string' },
	{ name: 'instructionsHash', type: 'string' },
	{ name: 'schemaHash', type: 'string' },
	{ name: 'schema' },
	{ name: 't', type: 'number' },
	{ name: 'epsilon', type: 'number' },
	{ name: 'cutoff', type: 'number' },
	{ name: 'evidenceAt', type: 'number' },
	{ name: 'fittedAt', type: 'number' },
	{ name: 'lastFittedAt', type: 'number', indexed: true },
	{ name: 'owner', type: 'string', indexed: true },
	{ name: 'boundary' },
	{ name: 'before', type: 'number' },
	{ name: 'applyUntil', type: 'number' },
	{ name: 'expiresAt', expiresAt: true, indexed: true },
	{ name: 'eligible', type: 'boolean' },
	{ name: 'reason', type: 'string' },
	{ name: 'policy' },
	{ name: 'policyDigest', type: 'string' },
	{ name: 'inputDigest', type: 'string' },
	{ name: 'decisions', type: 'number' },
	{ name: 'labelled', type: 'number' },
	{ name: 'report' },
];

let calibrations: any;

/** Declared like the decision tables: a read-only node takes what the catalog holds and declares nothing. */
export function getCalibrationsTable(readOnly = isReadOnlyMode()): any {
	if (calibrations) return calibrations;
	const handle: any = readOnly
		? getDatabases().system?.[CALIBRATIONS_TABLE]
		: table({
				table: CALIBRATIONS_TABLE,
				database: 'system',
				// Declared positively, like the decision tables: every node must apply the same versions.
				replicate: true,
				audit: true,
				attributes: CALIBRATION_ATTRIBUTES,
			});
	if (handle) {
		handle.loadAsInstance = false;
		calibrations = handle;
	}
	return handle;
}

export function resetCalibrationsTable(): void {
	calibrations = undefined;
	resetCalibrationCache();
}

export function declareCalibrationsTableAtBoot(): void {
	if (isReadOnlyMode()) return;
	try {
		getCalibrationsTable();
	} catch (err) {
		log.warn?.(`models: calibration table could not be declared at boot: ${safeErrorMessage(err)}`);
	}
}

function freshContext(): Context {
	const user = contextStorage.getStore()?.user;
	return (user ? { user } : {}) as Context;
}

let settings: Settings | undefined;
let activePolicyDigest: string | undefined;

export function isCalibrationEnabled(): boolean {
	return settings !== undefined;
}

function policyOf(config: Settings): FitPolicy {
	return {
		minReport: config.minReport,
		minTrain: config.minTrain,
		minHeldOut: config.minHeldOut,
		heldOutShare: config.heldOutShare,
		eceMargin: config.eceMargin,
		maxAgeMs: config.maxAgeMs,
	};
}

/**
 * Apply the `models.calibration` block. Present: fits apply on every worker, and the application primary
 * worker registers the cluster-once job. Absent: nothing applies and the job is removed.
 */
export function configureCalibration(
	block: CalibrationConfig | null | undefined,
	primary = isApplicationPrimaryWorker(undefined)
): void {
	resetCalibrationCache();
	if (!block) {
		settings = undefined;
		activePolicyDigest = undefined;
		if (primary) unregisterInternalJobs(JOB_NAME);
		return;
	}
	settings = { ...DEFAULTS, ...definedOnly(block) };
	activePolicyDigest = policyDigest(policyOf(settings));
	if (!primary || isReadOnlyMode()) return;
	registerInternalJobs(JOB_NAME, [
		{
			name: 'calibrate',
			componentName: internalJobOwner(JOB_NAME),
			intervalMs: settings.interval,
			handler: calibrationJob,
		},
	]);
	startSchedulerEngine();
}

/** The scheduled run: a failed run fails the job, so the scheduler's state shows it. */
export async function calibrationJob(): Promise<void> {
	const run = await runCalibration();
	if (run.status === 'failed') throw new Error(`calibration run failed: ${run.error}`);
}

function definedOnly(block: CalibrationConfig): CalibrationConfig {
	return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined)) as CalibrationConfig;
}

interface CacheEntry {
	fit: CalibrationRow | null;
	loadedAt: number;
}

const cache = new Map<string, CacheEntry>();
const loading = new Map<string, object>();
let generation = 0;
let outstandingReads = 0;
let lastFaultLog = 0;

export function resetCalibrationCache(): void {
	generation++;
	cache.clear();
	loading.clear();
}

function invalidate(keys: string[]): void {
	if (keys.length === 0) return;
	generation++;
	for (const key of keys) {
		cache.delete(key);
		loading.delete(key);
	}
}

export function outstandingCalibrationReads(): number {
	return outstandingReads;
}

function remember(key: string, fit: CalibrationRow | null): void {
	cache.delete(key);
	cache.set(key, { fit, loadedAt: Date.now() });
	while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

function logFault(what: string, err: unknown): void {
	const now = Date.now();
	if (now - lastFaultLog < FAULT_LOG_INTERVAL_MS) return;
	lastFaultLog = now;
	log.warn?.(`models: ${what}: ${safeErrorMessage(err)}`);
}

function ownerOf(tenant: string | undefined): string {
	return tenant == null ? 'none' : `t:${tenant}`;
}

function pad(n: number): string {
	return String(Math.max(0, Math.floor(n))).padStart(RANK_WIDTH, '0');
}

function rankOf(key: string, evidenceAt: number, fittedAt: number, id: string): string {
	return `${key}|${pad(evidenceAt)}|${pad(fittedAt)}|${id}`;
}

/** The newest version of a key: the greatest rank within the key's prefix, one descending index read. */
async function readNewest(key: string): Promise<CalibrationRow | null> {
	const rows = getCalibrationsTable();
	if (!rows) return null;
	return transaction(freshContext(), async () => {
		for await (const row of rows.search({
			conditions: [{ attribute: 'rank', comparator: 'starts_with', value: `${key}|`, descending: true }],
			limit: 1,
		})) {
			return row as CalibrationRow;
		}
		return null;
	});
}

function scheduleLoad(key: string, read: (key: string) => Promise<CalibrationRow | null> = readNewest): void {
	if (loading.has(key) || !settings || outstandingReads >= settings.maxLoads) return;
	const token = {};
	const startedAt = generation;
	loading.set(key, token);
	outstandingReads++;
	const owns = () => loading.get(key) === token && generation === startedAt;
	const timer = setTimeout(() => {
		if (!owns()) return;
		remember(key, null);
		loading.delete(key);
	}, LOAD_TIMEOUT_MS);
	timer.unref?.();
	let pending: Promise<CalibrationRow | null>;
	try {
		pending = read(key);
	} catch (err) {
		pending = Promise.reject(err);
	}
	pending
		.then(
			(row) => {
				if (owns()) remember(key, row);
			},
			(err) => {
				logFault('calibration lookup failed', err);
				if (owns()) remember(key, null);
			}
		)
		.catch(() => {})
		.finally(() => {
			clearTimeout(timer);
			outstandingReads--;
			if (loading.get(key) === token) loading.delete(key);
		});
}

/** @internal — testing only: replace the storage read the cache loads through. */
let readForLoads: ((key: string) => Promise<CalibrationRow | null>) | undefined;
export function setCalibrationReadForTests(read: ((key: string) => Promise<CalibrationRow | null>) | undefined): void {
	readForLoads = read;
}

function isUsable(row: CalibrationRow | null | undefined, now: number): row is CalibrationRow {
	return (
		!!row &&
		row.kind === 'fit' &&
		row.eligible === true &&
		row.applyUntil > now &&
		row.policyDigest === activePolicyDigest &&
		isValidParams(row)
	);
}

function cachedFit(key: string, now: number): CalibrationRow | undefined {
	const entry = cache.get(key);
	if (entry && now - entry.loadedAt < CACHE_FRESH_MS) {
		cache.delete(key);
		cache.set(key, entry);
		return isUsable(entry.fit, now) ? entry.fit : undefined;
	}
	scheduleLoad(key, readForLoads);
	return undefined;
}

export interface CalibrationSnapshot {
	field?: string;
	fitId: string;
	t: number;
	epsilon: number;
}

export interface AppliedCalibration<T> {
	decision: Omit<Decision<T>, 'id' | 'usage'>;
	rawDistribution?: DecisionOutcome[];
	rawFields?: Record<string, FieldDecision>;
	snapshot: CalibrationSnapshot[];
}

function hasNoMatchLeaf(schema: DecisionSchema): boolean {
	if (isObjectSchema(schema)) return Object.values(schema.properties).some((leaf) => leaf.noMatch === true);
	return (schema as DecisionLeaf).noMatch === true;
}

/**
 * The decision with every distribution replaced by its population's fit, or undefined when any field lacks
 * a cached usable fit or the order would change: all fields or none. Never waits on storage. A schema with
 * a no-match leaf is never fit-calibrated, because its no-match score would stay raw under `calibrated: true`.
 */
export function applyFits<T>(
	schema: DecisionSchema,
	decision: Omit<Decision<T>, 'id' | 'usage'>,
	population: string,
	now = Date.now()
): AppliedCalibration<T> | undefined {
	if (hasNoMatchLeaf(schema)) return undefined;
	if (isObjectSchema(schema)) {
		const fields = decision.fields;
		if (!fields) return undefined;
		const names = Object.keys(schema.properties);
		const fits = names.map((name) => cachedFit(calibrationKey(population, name), now));
		if (fits.some((fit) => !fit)) return undefined;
		const calibrated: Record<string, FieldDecision> = {};
		const snapshot: CalibrationSnapshot[] = [];
		for (let i = 0; i < names.length; i++) {
			const fit = fits[i] as CalibrationRow;
			const marginal = calibrateMarginal(schema.properties[names[i]], fields[names[i]], fit);
			if (!marginal) return undefined;
			calibrated[names[i]] = marginal;
			snapshot.push({ field: names[i], fitId: fit.id, t: fit.t, epsilon: fit.epsilon });
		}
		return { decision: { ...decision, fields: calibrated, calibrated: true }, rawFields: fields, snapshot };
	}
	const fit = cachedFit(calibrationKey(population, undefined), now);
	if (!fit || !decision.distribution) return undefined;
	const marginal = calibrateMarginal(
		schema as DecisionLeaf,
		{ value: decision.value, probability: decision.probability as number, distribution: decision.distribution },
		fit
	);
	if (!marginal) return undefined;
	return {
		decision: { ...decision, probability: marginal.probability, distribution: marginal.distribution, calibrated: true },
		rawDistribution: decision.distribution,
		snapshot: [{ fitId: fit.id, t: fit.t, epsilon: fit.epsilon }],
	};
}

function calibrateMarginal(
	leaf: DecisionLeaf,
	marginal: FieldDecision | undefined,
	fit: CalibrationParams
): FieldDecision | undefined {
	if (!marginal) return undefined;
	const values = allowedValues(leaf);
	const vector = toVector(marginal.distribution, values);
	if (!vector) return undefined;
	const out = applyCalibration(vector, fit);
	if (!out.every(Number.isFinite)) return undefined;
	const indexByValue = new Map(values.map((value, i) => [canonicalJson(value), i]));
	const distribution = marginal.distribution.map((entry) => ({
		value: entry.value,
		probability: out[indexByValue.get(canonicalJson(entry.value)) as number],
	}));
	for (let i = 1; i < distribution.length; i++)
		if (distribution[i].probability > distribution[i - 1].probability) return undefined;
	if (canonicalJson(distribution[0].value) !== canonicalJson(marginal.value)) return undefined;
	return { value: marginal.value, probability: distribution[0].probability, distribution };
}

export interface RunDeps {
	now?: () => number;
}

let queue: Promise<unknown> = Promise.resolve();

/** One run at a time per process. Resolves with the run's result, an unexpected fault included as a failed run. */
export function runCalibration(budgets: CalibrationBudgets = {}, deps: RunDeps = {}): Promise<CalibrationRunResult> {
	const next = queue.then(() => runOnce(budgets, deps)).catch((err) => failedRun(err));
	queue = next;
	return next;
}

function failedRun(err: unknown): CalibrationRunResult {
	const error = `unexpected fault: ${safeErrorMessage(err)}`;
	log.error?.(`models: calibration run failed ${error}`);
	return {
		status: 'failed',
		error,
		scanned: 0,
		discovered: 0,
		processed: 0,
		pending: 0,
		written: 0,
		eligible: 0,
		skipped: 0,
		failed: 0,
		durationMs: 0,
	};
}

interface Discovered {
	head: Omit<PopulationHead, 'lastFittedAt' | 'expiresAt'>;
	lastFittedAt?: number;
	bytes: number;
}

async function runOnce(budgets: CalibrationBudgets, deps: RunDeps): Promise<CalibrationRunResult> {
	const now = deps.now ?? Date.now;
	const configured: Settings = { ...DEFAULTS, ...settings };
	const config: Settings = { ...configured, ...budgetsOnly(budgets, configured) };
	const policy = policyOf(config);
	const digestOfPolicy = policyDigest(policy);
	const started = now();
	const deadline = started + config.maxRunMs;
	const result: CalibrationRunResult = {
		status: 'completed',
		scanned: 0,
		discovered: 0,
		processed: 0,
		pending: 0,
		written: 0,
		eligible: 0,
		skipped: 0,
		failed: 0,
		durationMs: 0,
	};
	const { decisions, outcomes } = getDecisionTables();
	const store = getCalibrationsTable();
	if (!decisions || !outcomes || !store) return finish();

	const populations = new Map<string, Discovered>();
	const writtenKeys: string[] = [];
	let bytes = 0;
	await discover();
	try {
		const discovered = [...populations.values()];
		const known = await transaction(freshContext(), async () => {
			for (const found of discovered) {
				const head: PopulationHead | undefined = await store.get(found.head.id);
				if (head?.lastFittedAt !== undefined) found.lastFittedAt = head.lastFittedAt;
			}
			const out: PopulationHead[] = [];
			for await (const row of store.search({
				conditions: [{ attribute: 'kind', value: 'population' }],
				sort: { attribute: 'lastFittedAt' },
				limit: config.maxPopulations,
			}))
				out.push(row);
			return out;
		});
		for (const head of known) {
			if (populations.has(head.population)) continue;
			const size = POPULATION_OVERHEAD_BYTES + canonicalJson(head.schema).length;
			if (bytes + size > config.maxBytes) {
				result.stoppedBy ??= 'maxBytes';
				break;
			}
			bytes += size;
			const { lastFittedAt, expiresAt: _expiresAt, ...rest } = head;
			populations.set(head.population, { head: rest, lastFittedAt, bytes: size });
		}
	} catch (err) {
		fail('reading known populations', err);
	}
	result.discovered = populations.size;

	const ordered = processingOrder([...populations.values()]);
	const order = ordered.slice(0, config.maxPopulations);
	if (ordered.length > order.length) {
		result.stoppedBy ??= 'maxPopulations';
		result.pending = ordered.length - order.length;
	}
	for (let i = 0; i < order.length; i++) {
		if (now() >= deadline) {
			result.stoppedBy ??= 'maxRunMs';
			result.pending += order.length - i;
			break;
		}
		const outcome = await processPopulation(order[i], bytes);
		if (outcome === 'budget') {
			result.stoppedBy ??= 'maxBytes';
			result.pending += order.length - i;
			break;
		}
		if (outcome === 'deadline') {
			result.stoppedBy ??= 'maxRunMs';
			result.pending += order.length - i;
			break;
		}
		result.processed++;
	}
	invalidate(writtenKeys);
	return finish();

	/**
	 * Half the decision budget looks for new populations among the newest decisions; the rest continues from
	 * where the previous run stopped, so an older, quiet population is reached within a bounded number of runs.
	 */
	async function discover(): Promise<void> {
		const newest = await scan(undefined, [], Math.ceil(config.maxDecisions / 2));
		if (newest.fault || newest.stopped) return;
		if (newest.end) return saveCursor(undefined, []);
		let cursor: { before?: unknown; boundary?: unknown } | undefined;
		try {
			cursor = await transaction(freshContext(), () => store.get(CURSOR_ID));
		} catch (err) {
			logFault('calibration could not read its discovery cursor', err);
		}
		const saved = typeof cursor?.before === 'number' ? cursor.before : undefined;
		const savedSeen = Array.isArray(cursor?.boundary) ? (cursor.boundary as string[]) : [];
		const resume = saved !== undefined && newest.before !== undefined && saved <= newest.before;
		const from = resume ? saved : newest.before;
		const seen = !resume
			? newest.boundary
			: saved === newest.before
				? [...new Set([...savedSeen, ...newest.boundary])]
				: savedSeen;
		const rest = await scan(from, seen, config.maxDecisions - result.scanned);
		if (rest.fault) return;
		if (result.scanned >= config.maxDecisions) result.stoppedBy ??= 'maxDecisions';
		return rest.end ? saveCursor(undefined, []) : saveCursor(rest.before, rest.boundary);
	}

	async function saveCursor(before: number | undefined, boundary: string[]): Promise<void> {
		try {
			await transaction(freshContext(), () =>
				store.put({ id: CURSOR_ID, kind: 'cursor', before, boundary, expiresAt: now() + DECISION_RETENTION_MS })
			);
		} catch (err) {
			logFault('calibration could not save its discovery cursor', err);
		}
	}

	async function scan(
		start: number | undefined,
		startSeen: string[],
		budget: number
	): Promise<{ before?: number; boundary: string[]; end: boolean; stopped: boolean; fault?: boolean }> {
		let before = start;
		let taken = 0;
		const seenAtBoundary = new Set<string>(start === undefined ? [] : startSeen);
		while (true) {
			let page: DecisionRow[];
			try {
				page = await transaction(freshContext(), async () => {
					const rows: DecisionRow[] = [];
					const conditions =
						before === undefined
							? [{ attribute: 'expiresAt', comparator: 'greater_than', value: 0, descending: true }]
							: [{ attribute: 'expiresAt', comparator: 'less_than_equal', value: before, descending: true }];
					for await (const row of decisions.search({ conditions, limit: SCAN_PAGE + seenAtBoundary.size })) {
						if (!seenAtBoundary.has(row.id)) rows.push(row);
					}
					return rows;
				});
			} catch (err) {
				fail('discovering populations', err);
				return { before, boundary: [...seenAtBoundary], end: false, stopped: true, fault: true };
			}
			if (page.length === 0) return { before, boundary: [...seenAtBoundary], end: true, stopped: false };
			for (const row of page) {
				if (taken >= budget) return { before, boundary: [...seenAtBoundary], end: false, stopped: false };
				if (now() >= deadline) {
					result.stoppedBy ??= 'maxRunMs';
					return { before, boundary: [...seenAtBoundary], end: false, stopped: true };
				}
				taken++;
				result.scanned++;
				result.reachedAt = Math.min(result.reachedAt ?? row.at, row.at);
				if (row.expiresAt !== before) seenAtBoundary.clear();
				before = row.expiresAt;
				seenAtBoundary.add(row.id);
				if (result.scanned % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
				if (!row.population || !row.signature || populations.has(row.population)) continue;
				if (populations.size >= config.maxPopulations) {
					result.stoppedBy ??= 'maxPopulations';
					return { before, boundary: [...seenAtBoundary], end: false, stopped: true };
				}
				const size = POPULATION_OVERHEAD_BYTES + canonicalJson(row.schema).length;
				if (bytes + size > config.maxBytes) {
					result.stoppedBy ??= 'maxBytes';
					return { before, boundary: [...seenAtBoundary], end: false, stopped: true };
				}
				bytes += size;
				populations.set(row.population, {
					bytes: size,
					head: {
						id: `population/${row.population}`,
						kind: 'population',
						population: row.population,
						owner: ownerOf(row.tenant),
						tenant: row.tenant,
						model: row.model,
						entry: row.entry ?? `registered:${row.backend}`,
						signature: row.signature,
						instructionsHash: row.instructionsHash,
						schemaHash: row.schemaHash,
						schema: row.schema,
					},
				});
			}
			if (page.length < SCAN_PAGE) return { before, boundary: [...seenAtBoundary], end: true, stopped: false };
		}
	}

	/** Reads, fits and writes one population; nothing is written for it unless it completes. */
	async function processPopulation(
		found: Discovered,
		baseBytes: number
	): Promise<'done' | 'budget' | 'deadline' | 'failed'> {
		const { head } = found;
		const schema = head.schema;
		let perKey: Array<{
			field: string | undefined;
			values: readonly unknown[];
			examples: Array<Example & { at: number }>;
			digester: ReturnType<typeof inputDigester>;
			evidenceAt: number;
			cutoff: number;
		}>;
		let noMatchSchema: boolean;
		try {
			const leaves: Array<[string | undefined, DecisionLeaf]> = isObjectSchema(schema)
				? Object.entries(schema.properties)
				: [[undefined, schema as DecisionLeaf]];
			perKey = leaves.map(([field, leaf]) => ({
				field,
				values: allowedValues(leaf),
				examples: [],
				digester: inputDigester(),
				evidenceAt: 0,
				cutoff: 0,
			}));
			noMatchSchema = hasNoMatchLeaf(schema);
		} catch (err) {
			result.failed++;
			logFault('calibration found a malformed population', err);
			try {
				const touchedAt = now();
				await transaction(freshContext(), () =>
					store.put({ ...head, lastFittedAt: touchedAt, expiresAt: touchedAt + policy.maxAgeMs })
				);
			} catch {}
			return 'failed';
		}
		let rows: DecisionRow[];
		let used = baseBytes;
		let newestExpiry = 0;
		try {
			rows = await transaction(freshContext(), async () => {
				const out: DecisionRow[] = [];
				for await (const row of decisions.search({
					conditions: [
						{ attribute: 'populationRank', comparator: 'starts_with', value: `${head.population}|`, descending: true },
					],
					limit: config.maxExamplesPerKey,
				})) {
					out.push(row);
				}
				return out;
			});
			rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			for (let start = 0; start < rows.length; start += YIELD_EVERY) {
				if (start > 0) {
					await new Promise((resolve) => setImmediate(resolve));
					if (now() >= deadline) return 'deadline';
				}
				const chunk = rows.slice(start, start + YIELD_EVERY);
				const chunkFacts = await transaction(freshContext(), () =>
					Promise.all(chunk.flatMap((row) => perKey.map((key) => outcomes.get(truthKey(row.id, key.field)))))
				);
				for (let r = 0; r < chunk.length; r++) {
					const row = chunk[r];
					if (row.expiresAt > newestExpiry) newestExpiry = row.expiresAt;
					const facts = chunkFacts.slice(r * perKey.length, (r + 1) * perKey.length);
					for (let i = 0; i < perKey.length; i++) {
						const key = perKey[i];
						const distribution =
							key.field === undefined
								? (row.rawDistribution ?? row.distribution)
								: (row.rawFields ?? row.fields)?.[key.field]?.distribution;
						const probabilities = toVector(distribution as DecisionOutcome[] | undefined, key.values);
						const fact = facts[i] as { state?: OutcomeTruth; at?: number } | undefined;
						key.digester.add([row.id, probabilities ?? null, fact?.state ?? null, fact?.at ?? null]);
						key.evidenceAt = Math.max(key.evidenceAt, row.at, fact?.at ?? 0);
						if (!probabilities || !fact?.state || fact.state.kind === 'unknown') continue;
						let truth: number;
						if (fact.state.kind === 'noMatch') truth = NO_MATCH_TRUTH;
						else {
							const expected = canonicalJson((fact.state as { value: unknown }).value);
							truth = key.values.findIndex((value) => canonicalJson(value) === expected);
							if (truth < 0) continue;
						}
						used += EXAMPLE_OVERHEAD_BYTES + probabilities.length * 8;
						if (used > config.maxBytes) return 'budget';
						key.examples.push({ probabilities, truth, at: row.at });
						key.cutoff = row.at;
					}
				}
			}
		} catch (err) {
			result.failed++;
			logFault('calibration could not read a population', err);
			return 'failed';
		}

		const epsilon = smoothingEpsilon(head.signature);
		const fittedAt = now();
		const written: CalibrationRow[] = [];
		try {
			for (const key of perKey) {
				const keyId = calibrationKey(head.population, key.field);
				const inputDigest = key.digester.digest();
				const previous = await readNewest(keyId);
				if (previous && previous.inputDigest === inputDigest && previous.policyDigest === digestOfPolicy) {
					result.skipped++;
					continue;
				}
				const labelled = key.examples.length;
				if (!previous && labelled < policy.minReport) {
					result.skipped++;
					continue;
				}
				const inSet = key.examples.filter((example) => example.truth !== NO_MATCH_TRUTH);
				const { train, heldOut } = splitByTime(key.examples, policy.heldOutShare);
				const trainInSet = train.filter((example) => example.truth !== NO_MATCH_TRUTH);
				const heldOutInSet = heldOut.filter((example) => example.truth !== NO_MATCH_TRUTH);
				const enough = trainInSet.length >= policy.minTrain && heldOutInSet.length >= policy.minHeldOut;
				let params: CalibrationParams | undefined;
				if (enough && !noMatchSchema) {
					params = await fitCalibration(trainInSet, epsilon, deadline, now);
					if (!params) return 'deadline';
				}
				const identity = (p: number[]) => p;
				let report: CalibrationReport | undefined;
				let improves = false;
				if (params) {
					const fitted = params;
					const raw = reliability(heldOut, identity);
					const calibrated = reliability(heldOut, (p) => applyCalibration(p, fitted));
					improves = calibrated.ece <= raw.ece - policy.eceMargin && calibrated.nll <= raw.nll;
					report = {
						window: 'heldOut',
						labelled,
						noMatchCount: labelled - inSet.length,
						trainCount: trainInSet.length,
						heldOutCount: heldOutInSet.length,
						raw,
						calibrated,
					};
				} else if (labelled >= policy.minReport) {
					report = {
						window: 'all',
						labelled,
						noMatchCount: labelled - inSet.length,
						trainCount: 0,
						heldOutCount: 0,
						raw: reliability(key.examples, identity),
					};
				}
				const eligible = Boolean(params) && improves;
				const reason: CalibrationRow['reason'] = noMatchSchema
					? 'no-match-schema'
					: !params
						? 'too-few-labels'
						: improves
							? undefined
							: 'no-improvement';
				const t = params?.t ?? 1;
				const id = fitId(keyId, inputDigest, policy, { t, epsilon, eligible, reason: reason ?? null });
				if (previous?.id === id) {
					result.skipped++;
					continue;
				}
				const applyUntil = fittedAt + policy.maxAgeMs;
				const evidenceAt = Math.max(key.evidenceAt, (previous?.evidenceAt ?? 0) + 1);
				const row: CalibrationRow = {
					id,
					kind: 'fit',
					key: keyId,
					rank: rankOf(keyId, evidenceAt, fittedAt, id),
					population: head.population,
					field: key.field,
					tenant: head.tenant,
					model: head.model,
					entry: head.entry,
					signature: head.signature,
					instructionsHash: head.instructionsHash,
					schemaHash: head.schemaHash,
					t,
					epsilon,
					cutoff: key.cutoff,
					evidenceAt,
					fittedAt,
					applyUntil,
					expiresAt: applyUntil + DECISION_RETENTION_MS,
					eligible,
					reason,
					policy,
					policyDigest: digestOfPolicy,
					inputDigest,
					decisions: rows.length,
					labelled,
					report,
				};
				written.push(row);
			}
			const headRow: PopulationHead = {
				...head,
				owner: ownerOf(head.tenant),
				lastFittedAt: fittedAt,
				expiresAt: Math.max(newestExpiry, fittedAt + policy.maxAgeMs),
			};
			await transaction(freshContext(), async () => {
				for (const row of written) await store.put(row);
				await store.put(headRow);
			});
		} catch (err) {
			result.failed++;
			logFault('calibration could not fit a population', err);
			return 'failed';
		}
		for (const row of written) writtenKeys.push(row.key);
		result.written += written.length;
		result.eligible += written.filter((row) => row.eligible).length;
		return 'done';
	}

	function fail(what: string, err: unknown): void {
		result.status = 'failed';
		result.error = `${what}: ${safeErrorMessage(err)}`;
		log.error?.(`models: calibration run failed ${result.error}`);
	}

	function finish(): CalibrationRunResult {
		if (result.failed > 0 && result.status === 'completed') {
			result.status = 'failed';
			result.error = `${result.failed} population(s) could not be processed`;
		}
		result.durationMs = now() - started;
		try {
			recordAction(result.durationMs, 'model-calibrate', undefined, result.status);
		} catch {}
		log.info?.(
			`models: calibration run ${result.status}: scanned ${result.scanned} decisions, ${result.discovered} populations, processed ${result.processed}, pending ${result.pending}, wrote ${result.written} (${result.eligible} eligible), skipped ${result.skipped}, failed ${result.failed}${result.stoppedBy ? `, stopped by ${result.stoppedBy}` : ''} in ${result.durationMs} ms`
		);
		return result;
	}
}

/** Never-fitted populations first, then the least recently fitted, so a run stopped by a budget resumes with what it skipped. */
export function processingOrder<P extends { head: { population: string }; lastFittedAt?: number }>(
	populations: P[]
): P[] {
	return [...populations].sort(
		(a, b) => (a.lastFittedAt ?? -1) - (b.lastFittedAt ?? -1) || a.head.population.localeCompare(b.head.population)
	);
}

/**
 * The newest version of every field of every population whose tenant equals the caller's, from the trusted
 * call context: absent matches only absent.
 */
export async function listCalibrations(
	tenant: string | undefined,
	filter: { model?: string } = {}
): Promise<CalibrationSummary[]> {
	const store = getCalibrationsTable();
	if (!store) return [];
	const now = Date.now();
	const out: CalibrationSummary[] = [];
	const owned: PopulationHead[] = await transaction(freshContext(), async () => {
		const rows: PopulationHead[] = [];
		for await (const row of store.search({
			conditions: [
				{ attribute: 'owner', value: ownerOf(tenant) },
				{ attribute: 'kind', value: 'population' },
			],
		}))
			rows.push(row);
		return rows;
	});
	for (const head of owned) {
		if ((head.tenant ?? null) !== (tenant ?? null)) continue;
		if (filter.model !== undefined && head.model !== filter.model) continue;
		const fields: Array<string | undefined> = isObjectSchema(head.schema)
			? Object.keys(head.schema.properties)
			: [undefined];
		const newest = await Promise.all(fields.map((field) => readNewest(calibrationKey(head.population, field))));
		for (const row of newest) {
			if (!row) continue;
			out.push({
				model: row.model,
				field: row.field,
				signature: row.signature,
				instructionsHash: row.instructionsHash,
				schemaHash: row.schemaHash,
				fittedAt: row.fittedAt,
				applyUntil: row.applyUntil,
				eligible: row.eligible,
				applied: isUsable(row, now),
				reason: row.reason,
				decisions: row.decisions,
				labelled: row.labelled,
				t: row.t,
				report: row.report,
			});
		}
	}
	return out.sort((a, b) => b.fittedAt - a.fittedAt);
}
