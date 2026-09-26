import { createHash, randomUUID } from 'node:crypto';
import { getDatabases, isReadOnlyMode, table } from '../databases.ts';
import { contextStorage, transaction } from '../transaction.ts';
import type { Context } from '../ResourceInterface.ts';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { canonicalJson, isAllowedValue, isObjectSchema } from './decision.ts';
import type {
	DecisionLeaf,
	DecisionRecord,
	DecisionSchema,
	LeafOutcomeReport,
	OutcomeAction,
	OutcomeReport,
	OutcomeTruth,
	RecordedLeafOutcome,
	RecordedOutcome,
} from './types.ts';

const log = harperLogger.forComponent('models').conditional;

export const DECISIONS_TABLE = 'hdb_model_decisions';
export const OUTCOMES_TABLE = 'hdb_model_outcomes';
/** Facts copy the decision's instant, so a report never extends a decision's life. */
export const DECISION_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** A `hdb_model_decisions` row: written once by `models.decide`, never rewritten. */
export interface DecisionRow {
	id: string;
	callId: number;
	at: number;
	expiresAt: number;
	tenant?: string;
	app?: string;
	backend: string;
	model: string;
	signature?: string;
	configHash?: string;
	instructionsHash?: string;
	schema: DecisionSchema;
	schemaHash: string;
	value: unknown;
	probability?: number;
	distribution?: DecisionRecord['distribution'];
	fields?: DecisionRecord['fields'];
	calibrated: boolean;
}

type Fact = 'truth' | 'action';

interface OutcomeRow {
	id: string;
	decisionId: string;
	fact: Fact;
	field?: string;
	state: OutcomeTruth | OutcomeAction;
	at: number;
	expiresAt: number;
}

/**
 * The catalog stub (`systemSchema.json` and the upgrade directive) declares only the primary key;
 * these declarations add the attributes and the indexed `expiresAt` TTL. Writes go through the
 * Resource API, which maintains the index, so `indexed` holds here, unlike in `hdb_model_calls`.
 */
export const DECISION_ATTRIBUTES = [
	{ name: 'id', isPrimaryKey: true },
	{ name: 'callId', type: 'number' },
	{ name: 'at', type: 'number' },
	{ name: 'expiresAt', expiresAt: true, indexed: true },
	{ name: 'tenant', type: 'string' },
	{ name: 'app', type: 'string' },
	{ name: 'backend', type: 'string' },
	{ name: 'model', type: 'string' },
	{ name: 'signature', type: 'string' },
	{ name: 'configHash', type: 'string' },
	{ name: 'instructionsHash', type: 'string' },
	{ name: 'schema' },
	{ name: 'schemaHash', type: 'string' },
	{ name: 'value' },
	{ name: 'probability', type: 'number' },
	{ name: 'distribution' },
	{ name: 'fields' },
	{ name: 'calibrated', type: 'boolean' },
];

export const OUTCOME_ATTRIBUTES = [
	{ name: 'id', isPrimaryKey: true },
	{ name: 'decisionId', type: 'string' },
	{ name: 'fact', type: 'string' },
	{ name: 'field', type: 'string' },
	{ name: 'state' },
	{ name: 'at', type: 'number' },
	{ name: 'expiresAt', expiresAt: true, indexed: true },
];

export interface DecisionTables {
	decisions: any;
	outcomes: any;
}

let tables: DecisionTables | undefined;

/**
 * Declares both tables and memoizes the handles. A read-only node cannot write the catalog, so it
 * takes whatever the catalog already holds and declares nothing; a table not there yet reads as empty.
 */
export function getDecisionTables(readOnly = isReadOnlyMode()): DecisionTables {
	if (tables) return tables;
	const resolve = (name: string, attributes: object[]) => {
		const handle: any = readOnly
			? getDatabases().system?.[name]
			: table({
					table: name,
					database: 'system',
					// auditing is the replication feed, and both tables must replicate so an outcome can be
					// recorded through any node; must match systemSchema.json
					audit: true,
					attributes,
				});
		if (handle) handle.loadAsInstance = false;
		return handle;
	};
	const resolved = {
		decisions: resolve(DECISIONS_TABLE, DECISION_ATTRIBUTES),
		outcomes: resolve(OUTCOMES_TABLE, OUTCOME_ATTRIBUTES),
	};
	if (resolved.decisions && resolved.outcomes) tables = resolved;
	return resolved;
}

export function resetDecisionTables(): void {
	tables = undefined;
}

/**
 * Declared at boot on every writable node so the TTL index exists where decisions are never made.
 * A failure is logged, not thrown: the first `decide` declares again and reports its own error.
 */
export function declareDecisionTablesAtBoot(): void {
	if (isReadOnlyMode()) return;
	try {
		getDecisionTables();
	} catch (err) {
		log.warn?.(`Decision tables could not be declared at boot: ${(err as Error)?.message ?? err}`);
	}
}

export class DecisionNotFoundError extends ClientError {
	constructor(id: string) {
		super(
			`No decision '${id}' on this node: it may not exist, may have expired, or may not have replicated here yet`,
			404
		);
		this.name = 'DecisionNotFoundError';
	}
}

export class OutcomeReportError extends ClientError {
	constructor(message: string) {
		super(`Invalid outcome report: ${message}`, 400);
		this.name = 'OutcomeReportError';
	}
}

export class DecisionPersistenceError extends ServerError {
	constructor(message: string, statusCode = 500) {
		super(message, statusCode);
		this.name = 'DecisionPersistenceError';
	}
}

export interface DecisionStoreOpts {
	getTables?: () => DecisionTables;
	isReadOnly?: () => boolean;
}

interface Found {
	row: DecisionRow;
	facts: Array<OutcomeRow | undefined>;
}

/**
 * Durable decisions and their recorded facts. Every operation runs in a transaction of its own
 * (`transaction` with a context object that is not the ALS store), so a decision made inside an
 * application transaction survives that transaction's abort, and the commit is awaited before the
 * id is returned to the caller.
 */
export class DecisionStore {
	#getTables: () => DecisionTables;
	#isReadOnly: () => boolean;

	constructor(opts: DecisionStoreOpts = {}) {
		this.#getTables = opts.getTables ?? getDecisionTables;
		this.#isReadOnly = opts.isReadOnly ?? isReadOnlyMode;
	}

	assertWritable(what: 'Decisions' | 'Outcomes'): void {
		if (this.#isReadOnly()) throw new DecisionPersistenceError(`${what} cannot be recorded on a read-only node`, 503);
	}

	async persist(row: DecisionRow): Promise<void> {
		const { decisions } = this.#getTables();
		await transaction(freshContext(), () => decisions.put(row));
	}

	async get(id: string, tenant?: string): Promise<DecisionRecord | undefined> {
		return storageFaultsAs('Decision could not be read', () =>
			transaction(freshContext(), async () => {
				const found = await this.#read(id, tenant);
				return found && { ...found.row, outcome: assembleOutcome(found.row.schema, found.facts) };
			})
		);
	}

	async recordOutcome(id: string, report: OutcomeReport, tenant?: string): Promise<DecisionRecord> {
		this.assertWritable('Outcomes');
		const { outcomes } = this.#getTables();
		return storageFaultsAs('Outcome could not be recorded', () =>
			transaction(freshContext(), async () => {
				const found = await this.#read(id, tenant);
				if (!found) throw new DecisionNotFoundError(id);
				const { row, facts } = found;
				const at = Date.now();
				for (const reported of validateReport(row.schema, report)) {
					const index = factIndex(row.schema, reported.fact, reported.field);
					const existing = facts[index];
					if (existing && canonicalJson(existing.state) === canonicalJson(reported.state)) continue;
					const written: OutcomeRow = {
						id: factKey(id, reported.fact, reported.field),
						decisionId: id,
						fact: reported.fact,
						field: reported.field,
						state: reported.state,
						at,
						expiresAt: row.expiresAt,
					};
					await outcomes.put(written);
					facts[index] = written;
				}
				return { ...row, outcome: assembleOutcome(row.schema, facts) };
			})
		);
	}

	async #read(id: string, tenant: string | undefined): Promise<Found | undefined> {
		const { decisions, outcomes } = this.#getTables();
		if (!decisions || !outcomes) return undefined;
		const row: DecisionRow | undefined = await decisions.get(id);
		if (!row || !visibleTo(row, tenant)) return undefined;
		const facts: Array<OutcomeRow | undefined> = await Promise.all(
			factKeys(row.id, row.schema).map((key) => outcomes.get(key))
		);
		return { row, facts };
	}
}

let store: DecisionStore | undefined;
export function getDecisionStore(): DecisionStore {
	if (!store) store = new DecisionStore();
	return store;
}

export function newDecisionId(): string {
	return randomUUID();
}

/** A context of its own, so the transaction is separate, carrying the caller's user for the audit entry. */
function freshContext(): Context {
	const user = contextStorage.getStore()?.user;
	return (user ? { user } : {}) as Context;
}

function visibleTo(row: DecisionRow, tenant: string | undefined): boolean {
	return tenant === undefined || row.tenant === undefined || row.tenant === tenant;
}

function factKey(id: string, fact: Fact, field?: string): string {
	return field === undefined ? `${id}/${fact}` : `${id}/${fact}/${field}`;
}

/** Truth then action, per property in schema order for object schemas; `factIndex` follows the same order. */
function factKeys(id: string, schema: DecisionSchema): string[] {
	if (!isObjectSchema(schema)) return [factKey(id, 'truth'), factKey(id, 'action')];
	return Object.keys(schema.properties).flatMap((field) => [factKey(id, 'truth', field), factKey(id, 'action', field)]);
}

function factIndex(schema: DecisionSchema, fact: Fact, field: string | undefined): number {
	const offset = fact === 'truth' ? 0 : 1;
	if (!isObjectSchema(schema)) return offset;
	return Object.keys(schema.properties).indexOf(field as string) * 2 + offset;
}

function assembleOutcome(schema: DecisionSchema, facts: Array<OutcomeRow | undefined>): RecordedOutcome {
	if (!isObjectSchema(schema)) return leafOutcome(facts);
	const fields: Record<string, RecordedLeafOutcome> = {};
	const names = Object.keys(schema.properties);
	for (let i = 0; i < names.length; i++) fields[names[i]] = leafOutcome(facts.slice(i * 2, i * 2 + 2));
	return { fields };
}

function leafOutcome(facts: Array<OutcomeRow | undefined>): RecordedLeafOutcome {
	const outcome: RecordedLeafOutcome = {};
	for (const fact of facts) {
		if (!fact) continue;
		if (fact.fact === 'truth') {
			outcome.truth = fact.state as OutcomeTruth;
			outcome.truthAt = fact.at;
		} else {
			outcome.action = fact.state as OutcomeAction;
			outcome.actionAt = fact.at;
		}
	}
	return outcome;
}

const TRUTH_KINDS = ['value', 'noMatch', 'unknown'];
const ACTION_KINDS = ['value', 'noMatch', 'abstained', 'unknown'];

interface ReportedFact {
	fact: Fact;
	field?: string;
	state: OutcomeTruth | OutcomeAction;
}

/** Checks a report against the stored schema. Messages name fields, never reported values. */
function validateReport(schema: DecisionSchema, report: OutcomeReport): ReportedFact[] {
	if (!report || typeof report !== 'object' || Array.isArray(report))
		throw new OutcomeReportError('the report must be an object');
	const facts: ReportedFact[] = [];
	if (isObjectSchema(schema)) {
		if ('truth' in report || 'action' in report)
			throw new OutcomeReportError('an object schema takes { fields: { <name>: { truth?, action? } } }');
		const fields = (report as { fields?: unknown }).fields;
		if (!fields || typeof fields !== 'object' || Array.isArray(fields))
			throw new OutcomeReportError('an object schema needs a fields map');
		for (const [name, leafReport] of Object.entries(fields)) {
			if (!Object.hasOwn(schema.properties, name)) throw new OutcomeReportError(`unknown field '${name}'`);
			facts.push(...leafFacts(schema.properties[name], leafReport as LeafOutcomeReport, name));
		}
	} else {
		if ('fields' in report) throw new OutcomeReportError('a leaf schema takes { truth?, action? }');
		facts.push(...leafFacts(schema, report as LeafOutcomeReport, undefined));
	}
	if (facts.length === 0) throw new OutcomeReportError('the report carries no fact');
	return facts;
}

function leafFacts(leaf: DecisionLeaf, report: LeafOutcomeReport, field: string | undefined): ReportedFact[] {
	const label = field === undefined ? 'the report' : `field '${field}'`;
	if (!report || typeof report !== 'object' || Array.isArray(report))
		throw new OutcomeReportError(`${label} must be an object`);
	const facts: ReportedFact[] = [];
	if (report.truth !== undefined)
		facts.push({ fact: 'truth', field, state: checkState(leaf, report.truth, TRUTH_KINDS, `${label}: truth`) });
	if (report.action !== undefined)
		facts.push({ fact: 'action', field, state: checkState(leaf, report.action, ACTION_KINDS, `${label}: action`) });
	return facts;
}

function checkState(leaf: DecisionLeaf, state: unknown, kinds: string[], label: string): OutcomeTruth | OutcomeAction {
	if (!state || typeof state !== 'object' || Array.isArray(state))
		throw new OutcomeReportError(`${label} must be a tagged state`);
	const { kind, value } = state as { kind?: unknown; value?: unknown };
	if (typeof kind !== 'string' || !kinds.includes(kind))
		throw new OutcomeReportError(`${label} has an unknown kind; expected one of ${kinds.join(', ')}`);
	if (kind === 'value') {
		if (!isAllowedValue(leaf, value)) throw new OutcomeReportError(`${label} is not an allowed value`);
		return { kind, value };
	}
	return { kind } as OutcomeTruth | OutcomeAction;
}

let modelsConfigHash: string | undefined;

/**
 * Identity of the model configuration actually installed, recorded on each decision so a reload
 * that changes the model behind an unchanged logical name still separates the decisions it produced.
 * Credential-looking keys are dropped before hashing.
 */
export function setModelsConfigHash(installed: unknown): void {
	modelsConfigHash = installed
		? createHash('sha256')
				.update(canonicalJson(withoutCredentials(installed)))
				.digest('hex')
		: undefined;
}

export function getModelsConfigHash(): string | undefined {
	return modelsConfigHash;
}

const CREDENTIAL_KEY = /key|secret|token|password|credential|auth/i;

function withoutCredentials(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCredentials);
	if (!value || typeof value !== 'object') return value;
	const kept: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!CREDENTIAL_KEY.test(key)) kept[key] = withoutCredentials(entry);
	}
	return kept;
}

/** A fault from the storage layer can name a data path; only its class and a fixed message may reach a response body. */
async function storageFaultsAs<T>(message: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof ClientError || err instanceof DecisionPersistenceError) throw err;
		const error = new DecisionPersistenceError(message);
		(error as Error & { cause?: unknown }).cause = err;
		throw error;
	}
}
