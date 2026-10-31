import { ClientError, IndexRebuildingError, Violation } from '../utility/errors/hdbError.ts';
import { when } from '../utility/when.ts';
import { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH, SEARCH_TYPES } from '../utility/lmdb/terms.ts';
import { compareKeys, MAXIMUM_KEY, writeKey } from 'ordered-binary';
import { SKIP, ExtendedIterable } from '@harperfast/extended-iterable';
import { INVALIDATED, EVICTED, freezeRecord } from './Table.ts';
import type { DirectCondition, Id } from './ResourceInterface.ts';
import { RequestTarget } from './RequestTarget.ts';
import { lastMetadata } from './RecordEncoder.ts';
import { writeKeyId, getReadTransactionGuard } from './DatabaseTransaction.ts';
import { recordAction } from './analytics/write.ts';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { appendHeader } from '../server/serverHelpers/Headers.ts';
import type { FullTextCondition } from './indexes/fullTextQueryIndex.ts';
import {
	FULL_TEXT_POSITIVE_COMPARATORS,
	fullTextComparatorMode,
	fullTextFuzzyOptions,
	validateFullTextFuzzyOptions,
	validateFullTextScoringOptions,
} from './indexes/fullTextQueryProtocol.ts';

export { fullTextComparatorMode, validateFullTextFuzzyOptions, validateFullTextScoringOptions };

// these are ratios/percentages of overall table size
const OPEN_RANGE_ESTIMATE = 0.3;
const BETWEEN_ESTIMATE = 0.1;
const STARTS_WITH_ESTIMATE = 0.05;

function getStringPrefixUpperBound(prefix: string): Uint8Array {
	const maximumEncodedLength = prefix.length * 3 + 3;
	const encodedPrefix = new Uint8Array((maximumEncodedLength + 7) & ~3);
	const encodedLength = writeKey(prefix, encodedPrefix, 0);
	const upperBound = encodedPrefix.subarray(0, encodedLength);
	// Incrementing the encoded prefix produces the exclusive bound immediately after every key with these bytes.
	for (let index = upperBound.length - 1; index >= 0; index--) {
		if (upperBound[index] < 0xff) {
			upperBound[index]++;
			return upperBound.slice(0, index + 1);
		}
	}
	return MAXIMUM_KEY;
}

// Synthetic Table-like object used to recurse through plain JSON nested-path
// segments. It has no attributes, indices, or property resolvers, so the
// recursive filterByType call dispatches purely on the comparator.
const NESTED_PATH_TABLE = Object.freeze({
	attributes: [],
	indices: {},
	primaryKey: null,
	propertyResolvers: null,
});

const SYMBOL_OPERATORS = {
	// these are coercing operators
	'<': 'lt',
	'<=': 'le',
	'>': 'gt',
	'>=': 'ge',
	'!=': 'ne',
	'==': 'eq',
	// these are strict operators:
	'===': 'equals',
	'!==': 'not_equal',
};
export const COERCIBLE_OPERATORS = {
	lt: true,
	le: true,
	gt: true,
	ge: true,
	ne: true,
	eq: true,
};
export function executeConditions(
	conditions,
	operator,
	table,
	txn,
	request,
	context,
	transformToEntries,
	filtered,
	recordAccess?,
	inUnion?: boolean
) {
	conditions = combineFullTextConditions(conditions, operator, table);
	const firstSearch = conditions[0];
	// A same-index full-text OR is already one native expression. Route that single traversal through
	// the AND path so row and vector guards are pushed down before the requested page is filled.
	if (operator === 'or' && conditions.length === 1 && firstSearch.fullTextQuery) operator = 'and';
	// Record-level guards (caller-supplied vectorFilter + rowFilter) apply to every record
	// the query returns, independent of which condition leads (#1241). `recordAccess` is supplied only on
	// the top-level executeConditions call (Table.search) and deliberately NOT threaded into the recursive
	// calls below, so the guards run exactly once — on the final result set — rather than redundantly at
	// each nested group.
	const recordGuards = buildRecordGuards(recordAccess);
	// both AND and OR start by getting an iterator for the ids for first condition
	// and then things diverge...
	if (operator === 'or') {
		let results = executeCondition(firstSearch);
		//get the union of ids from all condition searches
		for (let i = 1; i < conditions.length; i++) {
			const condition = conditions[i];
			// might want to lazily execute this after getting to this point in the iteration
			const nextResults = executeCondition(condition);
			results = results.concat(nextResults);
		}
		const deduped = distinctKeys(results);
		// Record guards must hold on the OR union too — loading each surviving record and dropping the
		// ones the guards reject (transformToEntries loads the record to evaluate a filter). Without this
		// a row filter would be bypassed by any OR query.
		return recordGuards ? transformToEntries(deduped, recordGuards) : deduped;
	} else {
		// AND: use the indexed query for the first condition and filter by all subsequent conditions.
		const pushdownIndex = filterablePushdownIndex(firstSearch, table);
		if (pushdownIndex) {
			// The lead is a filterable custom index (HNSW). It doesn't populate the join map (`filtered`)
			// that sibling filters read, so — unlike the general case below — we can build the sibling
			// filters BEFORE executing the lead and push them into the traversal, so filtering happens
			// during the graph walk instead of post-filtering an under-filled candidate set (#1241). They
			// also stay in the post-filter chain as a deterministic, harmless re-check.
			const siblings = conditions.slice(1);
			const filters = mapConditionsToFilters(siblings, true, firstSearch.estimated_count, inUnion);
			const recordFilters = recordGuards ? filters.concat(recordGuards) : filters;
			// The sibling conditions a secondary-index range scan answers exactly can seed an allow-set
			// the index admits from, instead of loading and decoding a record at every visited node.
			// The post-filter chain below stays whole, so the set only has to be a SUPERSET of the true
			// matches — the index decides whether building it beats evaluating the predicate.
			const candidateKeys =
				pushdownIndex.candidateKeyFilter && siblings.length > 0
					? planCandidateKeys(siblings, table, txn, !recordGuards, Boolean(pushdownIndex.candidateKeyProbe))
					: undefined;
			// Execute a COPY carrying the pushed-down predicate, never mutating the caller's condition
			// object (which may be reused across requests with different users / guards).
			const lead =
				recordFilters.length > 0
					? { ...firstSearch, recordFilter: composeRecordFilter(recordFilters, table, context), candidateKeys }
					: firstSearch;
			const results = executeCondition(lead);
			return recordFilters.length > 0 ? transformToEntries(results, recordFilters) : results;
		}
		// General path: execute the lead FIRST — a leading join populates `filtered`, which the sibling
		// filters read as they are built — then apply the sibling filters plus any record guards.
		const results = executeCondition(firstSearch);
		const filters = mapConditionsToFilters(conditions.slice(1), true, firstSearch.estimated_count, inUnion);
		const recordFilters = recordGuards ? filters.concat(recordGuards) : filters;
		return recordFilters.length > 0 ? transformToEntries(results, recordFilters) : results;
	}
	function executeCondition(condition) {
		if (condition.conditions)
			return executeConditions(
				condition.conditions,
				condition.operator,
				table,
				txn,
				request,
				context,
				transformToEntries,
				filtered,
				undefined, // recordAccess intentionally omitted: guards run once, at the top level (see above).
				inUnion || operator === 'or'
			);
		return searchByIndex(condition, txn, condition.descending || request.reverse === true, table, {
			allowFullScan: request.allowFullScan,
			filtered,
			context,
			holderTable: table,
			holderReadTxn: txn,
			disableSnapshot: request.snapshot === false,
			leaseHost: filtered,
			minResults:
				request.limit === 0 ? 0 : request.limit !== undefined ? (request.offset || 0) + request.limit : undefined,
			resultOffset: request.offset || 0,
		});
	}
	function mapConditionsToFilters(conditions, intersection, estimatedIncomingCount, inUnion: boolean) {
		return conditions
			.map((condition, index) => {
				if (condition.conditions) {
					// this is a group of conditions, we need to combine them
					const union = condition.operator === 'or';
					const filters = mapConditionsToFilters(
						condition.conditions,
						!union,
						estimatedIncomingCount,
						inUnion || union
					);
					const groupFilter: any = union
						? (record, entry) => filters.some((filter) => filter(record, entry))
						: (record, entry) => filters.every((filter) => filter(record, entry));
					if (filters.some((filter) => filter.maybeAsync))
						groupFilter.maybeAsync = (record, entry) => matchesFilters(filters, record, entry, union);
					return groupFilter;
				}
				const isPrimaryKey = (condition.attribute || condition[0]) === table.primaryKey;
				const filter = filterByType(condition, table, context, filtered, isPrimaryKey, estimatedIncomingCount, inUnion);
				if (intersection && index < conditions.length - 1 && estimatedIncomingCount) {
					estimatedIncomingCount = intersectionEstimate(
						table.primaryStore,
						condition.estimated_count,
						estimatedIncomingCount
					);
				}
				return filter;
			})
			.filter(Boolean);
	}
}

/**
 * Build the record-level guards that apply to a query independent of its conditions:
 *   - `vectorFilter`: a caller-supplied `(record) => boolean` predicate (JS-API only).
 *   - `rowFilter`: an explicit application-supplied predicate, bound to the current request context
 *     by Table.search.
 * Both arrive already resolved on `recordAccess` (assembled once in Table.search). Returns an array of
 * `(record) => boolean` predicates, or undefined when neither is defined (the common case — zero
 * overhead). Predicates must be synchronous and side-effect free; records passed in are frozen.
 */
function buildRecordGuards(recordAccess): ((record: any) => boolean)[] | undefined {
	if (!recordAccess) return undefined;
	const guards: ((record: any) => boolean)[] = [];
	const vectorFilter = recordAccess.vectorFilter;
	if (typeof vectorFilter === 'function') guards.push((record) => vectorFilter(record));
	if (recordAccess.rowFilter) guards.push(recordAccess.rowFilter);
	return guards.length > 0 ? guards : undefined;
}

function conditionIndex(table: any, attributeName: any, preferFullText = false): any {
	if (Array.isArray(attributeName) && attributeName.length === 1) attributeName = attributeName[0];
	if (typeof attributeName !== 'string') return;
	return preferFullText ? table.fullTextQueryIndexes?.[attributeName] : table.indices?.[attributeName];
}

function combineFullTextConditions(conditions: any[], operator: string | undefined, table: any): any[] {
	if (table.hasFullTextQueryIndexes === false || !containsFullTextCondition(conditions, table)) return conditions;
	let indexName: string | undefined;
	let positive = false;
	const expressions: any[] = [];
	const leaves: FullTextCondition['fullTextLeaves'] = [];
	const remaining: any[] = [];
	let includeHighlights = false;
	let maxIndexLagMilliseconds: number | undefined;
	let waitForIndexMilliseconds: number | undefined;
	for (const condition of conditions) {
		const compiled = compileFullTextExpression(condition, table);
		if (!compiled) {
			remaining.push(condition);
			continue;
		}
		if (operator === 'or' && compiled.remaining?.length)
			throw new ClientError('A full-text OR group cannot mix full-text and record conditions', 400);
		if (indexName && indexName !== compiled.indexName)
			throw new ClientError('One query cannot combine conditions from different full-text indexes', 400);
		indexName = compiled.indexName;
		expressions.push(compiled.expression);
		leaves.push(...compiled.leaves);
		positive ||= compiled.positive;
		includeHighlights ||= compiled.includeHighlights;
		maxIndexLagMilliseconds = mergeFullTextOption(
			'maxIndexLagMilliseconds',
			maxIndexLagMilliseconds,
			compiled.maxIndexLagMilliseconds
		);
		waitForIndexMilliseconds = mergeFullTextOption(
			'waitForIndexMilliseconds',
			waitForIndexMilliseconds,
			compiled.waitForIndexMilliseconds
		);
		if (compiled.remaining) remaining.push(...compiled.remaining);
	}
	if (!indexName) return conditions;
	if (operator === 'or' && remaining.length > 0)
		throw new ClientError('A full-text OR group cannot mix full-text and record conditions', 400);
	if (!positive) throw new ClientError('A full-text query requires at least one non-negated condition', 400);
	const expression =
		expressions.length === 1 ? expressions[0] : { operator: operator === 'or' ? 'or' : 'and', clauses: expressions };
	const combined = {
		attribute: indexName,
		comparator: 'matches',
		value: '',
		fullTextQuery: expression,
		fullTextLeaves: leaves,
		includeHighlights,
		...(maxIndexLagMilliseconds === undefined ? null : { maxIndexLagMilliseconds }),
		...(waitForIndexMilliseconds === undefined ? null : { waitForIndexMilliseconds }),
	};
	return operator === 'or' ? [combined] : [combined, ...remaining];
}

function containsFullTextCondition(conditions: any[], table: any): boolean {
	for (const condition of conditions) {
		if (condition.conditions) {
			if (containsFullTextCondition(condition.conditions, table)) return true;
			continue;
		}
		const indexName = condition[0] ?? condition.attribute;
		if (
			typeof indexName === 'string' &&
			table.fullTextQueryIndexes?.[indexName] &&
			fullTextComparatorMode(condition.comparator)
		)
			return true;
	}
	return false;
}

function compileFullTextExpression(
	condition: any,
	table: any
):
	| {
			indexName: string;
			expression: any;
			leaves: NonNullable<FullTextCondition['fullTextLeaves']>;
			positive: boolean;
			includeHighlights: boolean;
			maxIndexLagMilliseconds?: number;
			waitForIndexMilliseconds?: number;
			remaining?: any[];
	  }
	| undefined {
	if (condition.conditions) {
		validateFullTextFuzzyOptions(condition);
		validateFullTextScoringOptions(condition);
		const children = condition.conditions.map((child) => compileFullTextExpression(child, table));
		const fullTextChildren = children.filter(Boolean) as Array<NonNullable<(typeof children)[number]>>;
		if (fullTextChildren.length === 0) return;
		const groupOperator = condition.operator === 'or' ? 'or' : 'and';
		const remaining = condition.conditions.filter((_child, index) => !children[index]);
		for (const child of fullTextChildren) if (child.remaining) remaining.push(...child.remaining);
		if (groupOperator === 'or' && remaining.length > 0)
			throw new ClientError('A full-text OR group cannot mix full-text and record conditions', 400);
		const indexName = fullTextChildren[0].indexName;
		if (fullTextChildren.some((child) => child.indexName !== indexName))
			throw new ClientError('One query cannot combine conditions from different full-text indexes', 400);
		return {
			indexName,
			expression: { operator: groupOperator, clauses: fullTextChildren.map((child) => child.expression) },
			leaves: fullTextChildren.flatMap((child) => child.leaves),
			positive: fullTextChildren.some((child) => child.positive),
			includeHighlights: fullTextChildren.some((child) => child.includeHighlights),
			maxIndexLagMilliseconds: fullTextChildren.reduce(
				(value, child) => mergeFullTextOption('maxIndexLagMilliseconds', value, child.maxIndexLagMilliseconds),
				undefined as number | undefined
			),
			waitForIndexMilliseconds: fullTextChildren.reduce(
				(value, child) => mergeFullTextOption('waitForIndexMilliseconds', value, child.waitForIndexMilliseconds),
				undefined as number | undefined
			),
			...(remaining.length > 0 ? { remaining } : null),
		};
	}
	const indexName = condition[0] ?? condition.attribute;
	if (typeof indexName !== 'string' || !table.fullTextQueryIndexes?.[indexName]) return;
	const mode = fullTextComparatorMode(condition.comparator);
	if (!mode) return;
	if (typeof (condition[1] ?? condition.value) !== 'string')
		throw new ClientError(`Full-text index '${indexName}' requires a full-text comparator and string value`, 400);
	const text = condition[1] ?? condition.value;
	validateFullTextScoringOptions(condition, mode);
	const leaf = {
		text,
		mode,
		...fullTextFuzzyOptions(condition),
		...(condition.fields ? { fields: condition.fields } : null),
	};
	const withBoost = (clause: any, boost: number | undefined) =>
		boost === undefined ? clause : { operator: 'boost', boost: Math.fround(boost), clause };
	let expression = withBoost(leaf, condition.boost);
	const optionalLeaves = (condition.should ?? []).map((clause: any) => ({
		text: clause.value,
		mode: fullTextComparatorMode(clause.comparator),
		...fullTextFuzzyOptions(clause),
		fields: clause.fields,
	}));
	if (optionalLeaves.length > 0)
		expression = {
			operator: 'optional',
			required: expression,
			optional: optionalLeaves.map((clause: any, index: number) => withBoost(clause, condition.should[index].boost)),
		};
	return {
		indexName,
		expression: condition.negated ? { operator: 'not', clause: leaf } : expression,
		leaves: condition.negated ? [] : [leaf, ...optionalLeaves],
		positive: !condition.negated,
		includeHighlights: condition.includeHighlights === true,
		maxIndexLagMilliseconds: condition.maxIndexLagMilliseconds,
		waitForIndexMilliseconds: condition.waitForIndexMilliseconds,
	};
}

function mergeFullTextOption(name: string, current: number | undefined, next: number | undefined): number | undefined {
	if (next === undefined) return current;
	if (current !== undefined && current !== next)
		throw new ClientError(`Combined full-text conditions must use the same ${name}`, 400);
	return next;
}

function filterablePushdownIndex(condition, table): any {
	const attributeName = condition?.attribute ?? condition?.[0];
	if (attributeName == null || table == null) return undefined;
	const fullTextMode = Boolean(fullTextComparatorMode(condition?.comparator));
	const index =
		attributeName === table.primaryKey && !fullTextMode
			? table.primaryStore
			: conditionIndex(table, attributeName, fullTextMode);
	return index?.customIndex?.filteredSearch ? index.customIndex : undefined;
}

/**
 * Compose a set of record predicates into the single `(primaryKey) => boolean` the custom index calls
 * during traversal (#1241). The record is loaded lazily (only when the index reaches a node) via
 * `primaryStore.getEntry` and frozen before the predicates see it. Verdicts are memoized per query since
 * the graph can reach a node from multiple neighbors. A missing/deleted record fails the predicate.
 */
function composeRecordFilter(recordFilters, table, context): (primaryKey: Id, suppliedEntry?: any) => boolean {
	const memo = new Map<Id, boolean>();
	const transaction = context && table._readTxnForContext ? table._readTxnForContext(context) : undefined;
	return (primaryKey: Id, suppliedEntry?: any) => {
		const cached = memo.get(primaryKey);
		if (cached !== undefined) return cached;
		let verdict = false;
		const entry = suppliedEntry ?? table.primaryStore.getEntry(primaryKey, { transaction });
		const record = entry?.value;
		if (record != null) {
			freezeRecord(record);
			verdict = true;
			for (const filter of recordFilters) {
				if (!filter(record, entry)) {
					verdict = false;
					break;
				}
			}
		}
		memo.set(primaryKey, verdict);
		return verdict;
	};
}

/**
 * The candidate-key plan a filterable custom index receives alongside its pushed-down predicate:
 * the sibling AND conditions this query can answer from secondary-index range scans alone.
 * The index admits from the keys instead of re-deriving the condition per visited node, so a
 * condition on an indexed attribute costs a key-only index-entry read per matching record rather
 * than a record load and decode per node the traversal reaches.
 */
export interface CandidateKeyPlan {
	/** Planner estimate of the matching record count; the index sizes its work budget from it. */
	estimatedCount: number;
	/** Optional point-membership gate for exact conditions an index store can probe directly. */
	probe?: {
		/** Whether the probe covers every pushed-down condition and no opaque record guard remains. */
		complete: boolean;
		/** Planner estimate for the conditions this probe actually covers. */
		estimatedCount: number;
		/** Worst-case synchronous index reads performed by one call to `has`. */
		maxReadsPerCandidate: number;
		has(primaryKey: Id): boolean;
	};
	/**
	 * The matching primary keys, with `complete` true when the set alone decides admission, so the
	 * index may drop the traversal predicate. That needs every pushed-down condition covered, no
	 * opaque record guard (`rowFilter` / `vectorFilter`), and every term actually scanned — a term
	 * too wide for `maxKeys` is skipped rather than abandoning the whole set, leaving a narrower
	 * superset that gates the predicate instead of replacing it. Null when even the narrowest term
	 * overruns, which means the whole plan was not worth what it read.
	 */
	collect(maxKeys: number): CandidateKeyCollection | null;
	collect(maxKeys: number, cooperate: () => Promise<void>): Promise<CandidateKeyCollection | null>;
}

interface CandidateKeyCollection {
	keys: CandidateKeySet;
	complete: boolean;
}

/**
 * Primary keys by storage identity. Strings and non-zero numbers are their own identity, which spares
 * encoding the common key shapes, and the stores encode -0 and 0 apart where Set membership does not.
 * The rest go by writeKeyId, the encoder the stores index by — flattenKey joins composite keys with
 * NUL and collapses ['a', 'b\0c'] and ['a\0b', 'c'] — kept apart from the values because an encoded
 * identity is a string that can equal a string key: writeKeyId(['a', 'b']) is 'a\0b'.
 */
export class CandidateKeySet {
	#byValue = new Set<Id>();
	#encoded = new Set<unknown>();
	#zero = false;
	#negativeZero = false;
	add(primaryKey: Id): void {
		if (typeof primaryKey === 'object' || typeof primaryKey === 'bigint') primaryKey = storedSpelling(primaryKey);
		if (typeof primaryKey === 'string' || (typeof primaryKey === 'number' && primaryKey !== 0))
			this.#byValue.add(primaryKey);
		else if (primaryKey === 0) {
			if (Object.is(primaryKey, -0)) this.#negativeZero = true;
			else this.#zero = true;
		} else this.#encoded.add(writeKeyId(primaryKey));
	}
	has(primaryKey: Id): boolean {
		if (typeof primaryKey === 'object' || typeof primaryKey === 'bigint') primaryKey = storedSpelling(primaryKey);
		if (typeof primaryKey === 'string' || (typeof primaryKey === 'number' && primaryKey !== 0))
			return this.#byValue.has(primaryKey);
		if (primaryKey === 0) return Object.is(primaryKey, -0) ? this.#negativeZero : this.#zero;
		return this.#encoded.size > 0 && this.#encoded.has(writeKeyId(primaryKey));
	}
	addIfAbsent(primaryKey: Id): boolean {
		const size = this.size;
		this.add(primaryKey);
		return this.size !== size;
	}
	get size(): number {
		return this.#byValue.size + this.#encoded.size + (this.#zero ? 1 : 0) + (this.#negativeZero ? 1 : 0);
	}
}

/**
 * The string or number a key is stored as, when the key spells it another way: a BigInt a double holds
 * exactly encodes as that double (an index scan decodes it as the number, a traversal may report the
 * BigInt), and a one-element tuple encodes as its element when that is a string, or a number already at
 * the full width a tuple element takes (negative or fractional ones); other numbers encode shorter alone.
 */
function storedSpelling(primaryKey: Id): Id {
	if (typeof primaryKey === 'bigint') {
		const number = Number(primaryKey);
		return BigInt(number) === primaryKey ? number : primaryKey;
	}
	let element: unknown = primaryKey;
	while (Array.isArray(element) && element.length === 1) element = element[0];
	if (typeof element === 'string') return element;
	// NaN's payload bits stay in its encoding, which Set membership would not keep apart
	if ((typeof element !== 'number' && typeof element !== 'bigint') || element !== element) return primaryKey;
	const number = element as Id;
	if (writeKeyId(number) !== writeKeyId(primaryKey)) return primaryKey;
	return typeof element === 'bigint' ? storedSpelling(number) : number;
}

function primaryKeyEquals(value: Id): (primaryKey: Id) => boolean {
	const keys = new CandidateKeySet();
	keys.add(value);
	return (primaryKey) => keys.has(primaryKey);
}

export function distinctKeys(entries: any): any {
	if (Array.isArray(entries)) {
		const returned = new CandidateKeySet();
		return entries.filter((entry) => returned.addIfAbsent(entry.key ?? entry));
	}
	const distinct = new ExtendedIterable();
	(distinct as any).iterate = (options) => {
		const returned = new CandidateKeySet();
		// map rather than filter: filter clears `continueOnRecoverableError` for everything below it
		return entries.map((entry) => (returned.addIfAbsent(entry.key ?? entry) ? entry : SKIP)).iterate(options);
	};
	return distinct;
}

interface CandidateKeyScan {
	index: any;
	range: any;
	estimatedCount: number;
	predicateExact: boolean;
	probeValue?: any;
	canProbe?: boolean;
}
/** Scans whose UNION is one AND term; a single-element `scans` is a leaf condition. */
interface CandidateKeyTerm {
	scans: CandidateKeyScan[];
	estimatedCount: number;
}

// Comparators whose secondary-index range is EXACTLY the condition over the values an index holds,
// so scanning that range yields every indexed match and nothing else. `ne`, `in`, `contains`,
// `ends_with` and any negated condition are excluded because searchByIndex answers them with a scan
// plus a record filter.
const CANDIDATE_KEY_COMPARATORS = new Set([
	'equals',
	'lt',
	'le',
	'gt',
	'ge',
	'between',
	'gele',
	'gelt',
	'gtlt',
	'gtle',
]);

/**
 * Plan one leaf condition as an index range scan, or undefined when its matches cannot be read off
 * an index exactly, or when the scan's size cannot be estimated.
 */
function planCandidateKeyScan(condition, table, includePointProbe: boolean): CandidateKeyScan | undefined {
	if (condition.negated) return undefined;
	const attributeName = condition.attribute ?? condition[0];
	if (typeof attributeName !== 'string' || attributeName === table.primaryKey) return undefined;
	const index = usableIndex(table, attributeName);
	if (!index || index.customIndex) return undefined;
	const comparator = ALTERNATE_COMPARATOR_NAMES[condition.comparator] ?? condition.comparator ?? 'equals';
	if (!CANDIDATE_KEY_COMPARATORS.has(comparator)) return undefined;
	// The scan has to hold every key the record predicate admits, or results would depend on whether
	// the plan was built. The index cannot supply a record lacking the attribute, a null one unless it
	// indexes nulls, or one written as -0: ordered-binary encodes -0 past every number, and that entry's
	// primary key decodes wrong. A condition admitting any of these is left to the predicate.
	const predicate = filterByType(condition, table, undefined, null);
	if (predicate({}) || predicate({ [attributeName]: 0 }) || (!index.indexNulls && predicate({ [attributeName]: null })))
		return undefined;
	let value = condition[1] ?? condition.value;
	if (value instanceof Date) value = value.getTime();
	const attributeType = findAttribute(table.attributes, attributeName)?.type;
	const numericType =
		attributeType === 'Int' || attributeType === 'Long' || attributeType === 'Float' || attributeType === 'BigInt';
	// An untyped attribute can hold nested arrays, whose elements the predicate matches but no index holds, and
	// BigInts, which share a Number's index key but not its order, so a range set over one can omit or over-admit.
	if (comparator !== 'equals' && !numericType && attributeType !== 'String' && attributeType !== 'Date')
		return undefined;
	const predicateExact =
		comparator !== 'equals' || value === null || typeof value === 'string' || typeof value === 'boolean' || numericType;
	let start;
	let end;
	let inclusiveEnd = false;
	let exclusiveStart = false;
	switch (comparator) {
		case 'lt':
			start = null;
			exclusiveStart = true;
			end = value;
			break;
		case 'le':
			start = null;
			exclusiveStart = true;
			end = value;
			inclusiveEnd = true;
			break;
		case 'gt':
			start = value;
			exclusiveStart = true;
			break;
		case 'ge':
			start = value;
			break;
		case 'between':
		case 'gele':
		case 'gelt':
		case 'gtlt':
		case 'gtle':
			if (!Array.isArray(value)) return undefined;
			start = value[0] instanceof Date ? value[0].getTime() : value[0];
			end = value[1] instanceof Date ? value[1].getTime() : value[1];
			inclusiveEnd = comparator === 'gele' || comparator === 'gtle' || comparator === 'between';
			exclusiveStart = comparator === 'gtlt' || comparator === 'gtle';
			break;
		default:
			start = value;
			end = value;
			inclusiveEnd = true;
	}
	// ordered-binary encodes -0 above every number, where the predicate's compareKeys calls it 0.
	if (start === 0) start = 0;
	if (end === 0) end = 0;
	// An over-length string key is stored truncated behind an overflow marker, which makes the range
	// wider than the condition and needs a record filter to narrow again.
	if (
		(typeof start === 'string' && start.length > MAX_SEARCH_KEY_LENGTH) ||
		(typeof end === 'string' && end.length > MAX_SEARCH_KEY_LENGTH)
	)
		return undefined;
	if (condition.estimated_count === undefined) estimateCondition(table)(condition);
	const estimatedCount = condition.estimated_count;
	if (!(estimatedCount >= 0) || !Number.isFinite(estimatedCount)) return undefined;
	const canProbe = includePointProbe && comparator === 'equals' && typeof index.hasIndexEntry === 'function';
	return {
		index,
		range: { start, end, inclusiveEnd, exclusiveStart },
		estimatedCount,
		predicateExact,
		...(includePointProbe ? { probeValue: canProbe ? value : undefined, canProbe } : null),
	};
}

function planCandidateKeys(
	conditions,
	table,
	transaction,
	guardFree: boolean,
	includePointProbe: boolean
): CandidateKeyPlan | undefined {
	const terms: CandidateKeyTerm[] = [];
	const planned = collectCandidateKeyTerms(conditions, table, terms, includePointProbe) && guardFree;
	if (terms.length === 0) return undefined;
	const estimatedCount = terms.reduce((narrowest, term) => Math.min(narrowest, term.estimatedCount), Infinity);
	function collect(maxKeys: number): CandidateKeyCollection | null;
	function collect(maxKeys: number, cooperate: () => Promise<void>): Promise<CandidateKeyCollection | null>;
	function collect(maxKeys: number, cooperate?: () => Promise<void>) {
		return cooperate
			? collectCandidateKeysCooperatively(terms, transaction, maxKeys, planned, cooperate)
			: collectCandidateKeys(terms, transaction, maxKeys, planned);
	}
	const plan: CandidateKeyPlan = { estimatedCount, collect };
	if (!includePointProbe) return plan;
	const probeTerms = terms.filter((term) => term.scans.every((scan) => scan.canProbe));
	if (probeTerms.length === 0) return plan;
	const probeEstimatedCount = probeTerms.reduce(
		(narrowest, term) => Math.min(narrowest, term.estimatedCount),
		Infinity
	);
	const maxProbeReadsPerCandidate = probeTerms.reduce((total, term) => total + term.scans.length, 0);
	const probeOptions = { transaction };
	plan.probe = {
		complete: planned && probeTerms.length === terms.length,
		estimatedCount: probeEstimatedCount,
		maxReadsPerCandidate: maxProbeReadsPerCandidate,
		has(primaryKey) {
			for (const term of probeTerms) {
				let matched = false;
				for (const scan of term.scans) {
					if (scan.index.hasIndexEntry(scan.probeValue, primaryKey, probeOptions)) {
						matched = true;
						break;
					}
				}
				if (!matched) return false;
			}
			return true;
		},
	};
	return plan;
}

/** Returns whether every condition was covered. */
function collectCandidateKeyTerms(conditions, table, terms: CandidateKeyTerm[], includePointProbe: boolean): boolean {
	let complete = true;
	for (const condition of conditions) {
		if (condition.conditions) {
			if (condition.operator === 'or') {
				// A union is only sound in full: dropping one branch would exclude the records only
				// that branch matches, and admission may over-admit but never omit.
				const scans: CandidateKeyScan[] = [];
				for (const child of condition.conditions) {
					const scan = child.conditions ? undefined : planCandidateKeyScan(child, table, includePointProbe);
					if (!scan) {
						complete = false;
						break;
					}
					scans.push(scan);
				}
				if (scans.length === condition.conditions.length) {
					terms.push({ scans, estimatedCount: scans.reduce((total, scan) => total + scan.estimatedCount, 0) });
					if (scans.some((scan) => !scan.predicateExact)) complete = false;
				}
			} else if (!collectCandidateKeyTerms(condition.conditions, table, terms, includePointProbe)) complete = false;
			continue;
		}
		const scan = planCandidateKeyScan(condition, table, includePointProbe);
		if (scan) {
			terms.push({ scans: [scan], estimatedCount: scan.estimatedCount });
			if (!scan.predicateExact) complete = false;
		} else complete = false;
	}
	return complete;
}

const CANDIDATE_KEY_COLLECTION_YIELD_INTERVAL = 256;

/**
 * Run the planned scans narrowest-estimate first, intersecting on storage key identity. `maxKeys`
 * bounds index entries READ, not keys retained — a wide later scan whose intersection is tiny still
 * reads its whole range, and that is the cost the caller budgeted against. A term whose estimate
 * exceeds what is left of that budget is dropped instead: fewer AND terms is a wider superset, which
 * the predicate then narrows, and spending the budget on it only to abandon the set is pure loss.
 */
function collectCandidateKeys(
	terms: CandidateKeyTerm[],
	transaction,
	maxKeys: number,
	planned: boolean
): CandidateKeyCollection | null {
	const ordered = terms.length > 1 ? terms.slice().sort((a, b) => a.estimatedCount - b.estimatedCount) : terms;
	let matched: CandidateKeySet | undefined;
	let complete = planned;
	let scanned = 0;
	for (const term of ordered) {
		if (matched && term.estimatedCount > maxKeys - scanned) {
			complete = false;
			continue;
		}
		const next = new CandidateKeySet();
		let overran = false;
		for (const scan of term.scans) {
			for (const { value: primaryKey } of scan.index.getRange({ ...scan.range, values: true, transaction })) {
				if (++scanned > maxKeys) {
					overran = true;
					break;
				}
				if (!matched || matched.has(primaryKey)) next.add(primaryKey);
			}
			if (overran) break;
		}
		// A half-scanned term is not a superset of its own matches, so it is dropped whole.
		if (overran) {
			if (!matched) return null;
			complete = false;
			break;
		}
		matched = next;
		if (matched.size === 0) break;
	}
	return { keys: matched!, complete };
}

function* cooperativeCandidateKeyCollectionSteps(
	terms: CandidateKeyTerm[],
	transaction,
	maxKeys: number,
	planned: boolean
): Generator<void, CandidateKeyCollection | null> {
	const ordered = terms.length > 1 ? terms.slice().sort((a, b) => a.estimatedCount - b.estimatedCount) : terms;
	let matched: CandidateKeySet | undefined;
	let complete = planned;
	let scanned = 0;
	for (const term of ordered) {
		if (matched && term.estimatedCount > maxKeys - scanned) {
			complete = false;
			continue;
		}
		const next = new CandidateKeySet();
		let overran = false;
		for (const scan of term.scans) {
			for (const { value: primaryKey } of scan.index.getRange({ ...scan.range, values: true, transaction })) {
				if (++scanned > maxKeys) {
					overran = true;
					break;
				}
				if (!matched || matched.has(primaryKey)) next.add(primaryKey);
				if (scanned % CANDIDATE_KEY_COLLECTION_YIELD_INTERVAL === 0) yield;
			}
			if (overran) break;
		}
		if (overran) {
			if (!matched) return null;
			complete = false;
			break;
		}
		matched = next;
		if (matched.size === 0) break;
	}
	return { keys: matched!, complete };
}

async function collectCandidateKeysCooperatively(
	terms: CandidateKeyTerm[],
	transaction,
	maxKeys: number,
	planned: boolean,
	cooperate: () => Promise<void>
): Promise<CandidateKeyCollection | null> {
	const steps = cooperativeCandidateKeyCollectionSteps(terms, transaction, maxKeys, planned);
	try {
		let next = steps.next();
		while (!next.done) {
			await cooperate();
			next = steps.next();
		}
		return next.value;
	} finally {
		steps.return(null);
	}
}

/**
 * A record's index entries are not adjacent — the composite `[indexedValue, primaryKey]` key sorts
 * on the indexed value first — so comparing neighbours cannot collapse them and the scan has to
 * remember what it already yielded (#2434).
 *
 * Heap cost is one key per distinct record in the scanned range, held for the life of the scan, and
 * a page window does not cap it: sibling-condition and row filters run downstream, so a selective
 * filter keeps the scan running and the set growing while the page fills. On a multi-million-row
 * range that is hundreds of MB where main streamed at O(1). Accepted for #2434 over the bounded
 * alternative, which costs a primary read per index entry.
 */
function distinctRecords(entries: any): AsyncIterable<Id> {
	const distinct = new ExtendedIterable();
	(distinct as any).iterate = (options) => {
		// A non-scalar key decodes to a fresh instance per entry, so identity never matches it;
		// `writeKeyId` is the store's own key equality. Its bytes get their own set because a scalar
		// string id can legitimately carry exactly those bytes, and one set would fold the two —
		// the collision `flattenKey` has, and the reason Table.ts prefixes its key ids.
		const yieldedKeys = new Set();
		const yieldedEncodedKeys = new Set();
		// map rather than filter: filter clears `continueOnRecoverableError` for everything below it
		return entries
			.map((primaryKey) => {
				const isEncoded = typeof primaryKey === 'object' && primaryKey !== null;
				const yielded = isEncoded ? yieldedEncodedKeys : yieldedKeys;
				const identity = isEncoded ? writeKeyId(primaryKey) : primaryKey;
				if (yielded.has(identity)) return SKIP;
				yielded.add(identity);
				return primaryKey;
			})
			.iterate(options);
	};
	return distinct as any;
}

const RELATED_LEASES = Symbol('relatedLeases');

// The join scans another database's index after the request commits, so it leases that link's handle;
// the leases live on the search's `filtered` object until `Table.search` releases them.
function leaseRelatedReadTxn(relatedTable, context, holderTable, holderReadTxn, disableSnapshot, leaseHost) {
	if (!holderReadTxn || !leaseHost || !context) return;
	const holder = holderTable._txnForContext(context);
	const link = relatedTable._txnForContext(context);
	if (link === holder) return holderReadTxn;
	const leases = (leaseHost[RELATED_LEASES] ??= new Map());
	let lease = leases.get(link);
	if (!lease) leases.set(link, (lease = link.leaseReadTxn(holder, disableSnapshot)));
	return lease.readTxn;
}

export function releaseRelatedLeases(leaseHost) {
	const leases = leaseHost[RELATED_LEASES];
	if (leases) for (const lease of leases.values()) lease.onDone?.();
}

/**
 * Search for records or keys, based on the search condition, using an index if available. The four
 * leading parameters are required at every call site; everything optional is named, so a new
 * capability can be added without shifting positions at callers that don't use it.
 * @param searchCondition
 * @param transaction
 * @param reverse
 * @param Table
 * @param options
 */
export function searchByIndex(
	searchCondition: DirectCondition,
	transaction: any,
	reverse: boolean,
	Table: any,
	options: {
		allowFullScan?: boolean;
		filtered?: any;
		context?: any;
		// How many rows the query will ultimately consume (offset + limit), when it is bounded. An
		// approximate index returns a fixed-size candidate list, so without this a query asking for more
		// rows than that list holds silently gets a short result set. Only custom indexes read it.
		minResults?: number;
		// Rows before this offset are needed for correct paging but do not need highlight metadata.
		resultOffset?: number;
		// What a join into another database needs to lease that database's read handle for the search
		// (see leaseRelatedReadTxn); without them it reads that database's latest committed state.
		holderTable?: any;
		holderReadTxn?: any;
		disableSnapshot?: boolean;
		leaseHost?: any;
		leaseContext?: any;
	} = {}
): AsyncIterable<Id | { key: Id; value: any }> {
	// A stale positional caller passes `allowFullScan` here. Type checking only covers .ts callers, so
	// fail loud rather than silently reading every option as undefined.
	if (typeof options !== 'object' || options === null)
		throw new TypeError('searchByIndex: the 5th argument is an options object (#2165), not a positional value');
	const {
		allowFullScan,
		filtered,
		context,
		minResults,
		resultOffset,
		holderTable,
		holderReadTxn,
		disableSnapshot,
		leaseHost,
	} = options;
	const leaseContext = options.leaseContext ?? context;
	let attribute_name = searchCondition[0] ?? searchCondition.attribute;
	let value = searchCondition[1] ?? searchCondition.value;
	const comparator = searchCondition.comparator;
	const fullTextMode = fullTextComparatorMode(comparator);
	if (fullTextMode && typeof attribute_name !== 'string')
		throw new ClientError('Full-text comparator requires an index directly on the queried table', 400);
	if (!fullTextMode) Table.assertFullTextRecordField?.(attribute_name);
	if (value === undefined && (comparator as any) !== 'sort') {
		throw new ClientError(`Search condition for ${attribute_name} must have a value`);
	}
	let needFullScan;
	// `[indexedValue, primaryKey]` is unique, so a scan that stays inside one indexed value cannot
	// reach a record twice and skips the collapse below
	let scansOneIndexedValue;
	if (Array.isArray(attribute_name)) {
		const firstAttributeName = attribute_name[0];
		// get the potential relationship attribute
		const attribute = findAttribute(Table.attributes, firstAttributeName);
		if (attribute?.relationship) {
			// it is a join/relational query
			if (attribute_name.length < 2)
				throw new ClientError(
					'Can not directly query a relational attribute, must query an attribute within the target table'
				);
			const relatedTable = attribute.definition?.tableClass || attribute.elements?.definition?.tableClass;
			const joined = new Map();
			const relatedTxn =
				relatedTable.primaryStore.path === Table.primaryStore.path
					? transaction
					: leaseRelatedReadTxn(relatedTable, leaseContext, holderTable, holderReadTxn, disableSnapshot, leaseHost);
			// search the related table
			let results = searchByIndex(
				{
					attribute: attribute_name.length > 2 ? attribute_name.slice(1) : attribute_name[1],
					value,
					comparator,
					negated: searchCondition.negated,
				},
				relatedTxn,
				reverse,
				relatedTable,
				{ allowFullScan, filtered: joined, holderTable, holderReadTxn, disableSnapshot, leaseHost, leaseContext }
			);
			if (attribute.relationship.to) {
				// this is one-to-many or many-to-many, so we need to track the filtering of related entries that match
				filtered[attribute_name[0]] = joined;
				// Use the joinTo to join the results of the related table to the current table (can be one-to-many or many-to-many)
				const isManyToMany = Boolean(findAttribute(relatedTable.attributes, attribute.relationship.to)?.elements);
				results = joinTo(results, attribute, relatedTable.primaryStore, isManyToMany, joined, relatedTxn);
			}
			if (attribute.relationship.from) {
				const searchEntry = (relatedEntry) => {
					if (relatedEntry?.key !== undefined) relatedEntry = relatedEntry.key;
					return searchByIndex(
						{ attribute: attribute.relationship.from, value: relatedEntry },
						transaction,
						reverse,
						Table,
						{ allowFullScan, filtered: joined }
					);
				};
				if (attribute.elements) {
					filtered[attribute_name[0]] = joined;
					// many-to-many relationship (forward), get all the ids first
					results = joinFrom(results, attribute, relatedTable.primaryStore, joined, searchEntry, relatedTxn);
				} else {
					// many-to-one relationship, need to flatten the ids that point back to potentially many instances of this
					results = (results as any).flatMap(searchEntry);
				}
			}
			return results;
		} else if (attribute_name.length === 1) {
			attribute_name = attribute_name[0];
		} else {
			// Non-relationship nested path (plain JSON path). Phase 1: filter-only —
			// we don't have an index for the nested path, so fall through to a full
			// scan with `filterByType` walking the path on each record.
			needFullScan = true;
		}
	}
	if (fullTextMode) {
		if (typeof attribute_name !== 'string' || !Table.fullTextIndexes?.some(({ name }) => name === attribute_name))
			throw new ClientError('Full-text comparator requires a declared @fullText index', 400);
		if (!Table.fullTextQueryIndexes?.[attribute_name]?.customIndex)
			throw new IndexRebuildingError(`Full-text index '${attribute_name}' is not ready`);
	}
	const isPrimaryKey = !fullTextMode && (attribute_name === Table.primaryKey || attribute_name == null);
	const index = isPrimaryKey ? Table.primaryStore : conditionIndex(Table, attribute_name, Boolean(fullTextMode));
	// A primary store keeps symbol-keyed metadata (0x02) below `false` and opens at `true`, as it always
	// has; a secondary index starts just above its null block, which `true` would overshoot past `false`.
	const openStart = isPrimaryKey ? true : null;
	const openStartExclusive = !isPrimaryKey;
	let start;
	let end, inclusiveEnd, exclusiveStart, stringPrefix;
	const resolvedComparator = ALTERNATE_COMPARATOR_NAMES[comparator] || comparator;
	if (value instanceof Date) value = value.getTime();
	if (searchCondition.negated) {
		// Negated conditions are filter-only in Phase 1: scan the whole index/table
		// and exclude matching rows in the filter. Without overriding the range,
		// the bounded index iteration would only visit *included* rows.
		start = openStart;
		exclusiveStart = openStartExclusive;
		needFullScan = true;
	} else if (fullTextMode) {
		start = openStart;
		exclusiveStart = openStartExclusive;
	} else
		switch (resolvedComparator) {
			case 'lt':
				start = openStart;
				exclusiveStart = openStartExclusive;
				end = value;
				break;
			case 'le':
				start = openStart;
				exclusiveStart = openStartExclusive;
				end = value;
				inclusiveEnd = true;
				break;
			case 'gt':
				start = value;
				exclusiveStart = true;
				break;
			case 'ge':
				start = value;
				break;
			case 'prefix': // this is form finding multi-part keys that start with the provided prefix
				// this search needs to be of the form:
				// start: [prefix, null], end: [prefix, MAXIMUM_KEY]
				if (!Array.isArray(value)) value = [value, null];
				else if (value[value.length - 1] != null) value = value.concat(null);
				if (isPrimaryKey && value.length <= 1) {
					// no prefix ([] or [null]): every key, from the primary store's floor above its metadata
					start = openStart;
					exclusiveStart = openStartExclusive;
					break;
				}
				start = value;
				end = value.slice(0);
				end[end.length - 1] = MAXIMUM_KEY;
				break;
			case 'starts_with':
				start = value.toString();
				if (start.length === 0) {
					start = openStart;
					exclusiveStart = openStartExclusive;
					needFullScan = true;
				} else stringPrefix = true;
				break;
			case 'between':
			case 'gele':
			case 'gelt':
			case 'gtlt':
			case 'gtle': {
				rangeBounds(comparator, value);
				start = value[0];
				end = value[1];
				if (start instanceof Date) start = start.getTime();
				if (end instanceof Date) end = end.getTime();
				inclusiveEnd =
					resolvedComparator === 'gele' || resolvedComparator === 'gtle' || resolvedComparator === 'between';
				exclusiveStart = resolvedComparator === 'gtlt' || resolvedComparator === 'gtle';
				break;
			}
			case 'equals':
			case undefined:
				start = value;
				end = value;
				inclusiveEnd = true;
				scansOneIndexedValue = true;
				break;
			case 'in':
				// Phase 1: route through filter — index-merge optimization is a Phase 2 follow-up.
				// `value` is expected to be an array (empty array matches no rows).
				if (!Array.isArray(value)) throw new ClientError(`"in" comparator requires an array value`);
				start = openStart;
				exclusiveStart = openStartExclusive;
				needFullScan = true;
				break;
			case 'ne':
				if (value === null) {
					// since null is the lowest value in an index, we can treat anything higher as a non-null
					start = value;
					exclusiveStart = true;
					break;
				}
			case 'sort': // this is a special case for when we want to get all records for sorting
			case 'contains':
			case 'ends_with':
				// we have to revert to full table scan here
				start = openStart;
				exclusiveStart = openStartExclusive;
				needFullScan = true;
				break;
			default:
				throw new ClientError(`Unknown query comparator "${comparator}"`);
		}
	let filter;
	if (typeof start === 'string' && start.length > MAX_SEARCH_KEY_LENGTH) {
		// if the key is too long, we need to truncate it and filter the results
		start = start.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER;
		exclusiveStart = false;
		filter = filterByType(searchCondition, Table, null, filtered, isPrimaryKey);
	}
	if (typeof end === 'string' && end.length > MAX_SEARCH_KEY_LENGTH) {
		// if the key is too long, we need to truncate it and filter the results
		end = end.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER;
		inclusiveEnd = true;
		filter = filter ?? filterByType(searchCondition, Table, null, filtered, isPrimaryKey);
	}
	if (stringPrefix && index && !needFullScan) end = getStringPrefixUpperBound(start);
	if (reverse) {
		let newEnd = start;
		start = end;
		end = newEnd;
		newEnd = !exclusiveStart;
		exclusiveStart = !inclusiveEnd;
		inclusiveEnd = newEnd;
	}
	// For negated conditions we need to consider records whose attribute value is
	// missing from the index (e.g. nulls when the index doesn't index nulls), so
	// we bypass the secondary index and iterate over the primary store.
	const skipIndex = searchCondition.negated && index && !isPrimaryKey;
	if (!index || index.isIndexing || needFullScan || (value === null && !index.indexNulls) || skipIndex) {
		// no indexed searching available, need a full scan
		if (allowFullScan === false && !index)
			throw new ClientError(`"${attribute_name}" is not indexed, can not search for this attribute`, 404);
		if (allowFullScan === false && needFullScan)
			throw new ClientError(
				`Can not use ${
					comparator || 'equal'
				} operator without combining with a condition that uses an index, can not search for attribute ${attribute_name}`,
				403
			);
		if (index?.isIndexing)
			throw new IndexRebuildingError(`"${attribute_name}" is not indexed yet, can not search for this attribute`);
		if (value === null && index && !index.indexNulls)
			throw new ClientError(
				`"${attribute_name}" is not indexed for nulls, index needs to be rebuilt to search for nulls, can not search for this attribute`,
				400
			);
		filter = filter ?? filterByType(searchCondition, Table, null, filtered, isPrimaryKey);
		if (!filter) {
			throw new ClientError(`Unknown search operator ${searchCondition.comparator}`);
		}
	}
	const rangeOptions = {
		start,
		end,
		inclusiveEnd,
		exclusiveStart,
		values: true,
		versions: isPrimaryKey,
		transaction,
		reverse,
	};
	if (isPrimaryKey) {
		const primaryKey = Table.primaryKey;
		const admits = filter
			? ({ key, value, metadataFlags }) =>
					value == null ? metadataFlags & (INVALIDATED | EVICTED) && filter({ [primaryKey]: key }) : filter(value)
			: ({ value, metadataFlags }) => value != null || metadataFlags & (INVALIDATED | EVICTED);
		const toEntry = (entry) => {
			if (!admits(entry)) return SKIP;
			freezeRecord(entry.value);
			recordRead(entry);
			return entry;
		};
		const results = index.getRange(rangeOptions).map(function (entry) {
			if (this?.isSync) return toEntry(entry);
			// we intentionally yield the event turn so that scanning queries do not hog resources
			return new Promise((resolve, reject) =>
				setImmediate(() => {
					try {
						resolve(toEntry(entry));
					} catch (error) {
						reject(error);
					}
				})
			);
		});
		results.hasEntries = true;
		return results;
	} else if (index && !skipIndex) {
		if (index.customIndex) {
			// Predicate-aware traversal (#1241): a record filter composed from companion AND conditions,
			// caller-supplied vector and row filters are pushed into the index so it keeps
			// exploring until it has enough MATCHING results, rather than post-filtering an under-filled
			// candidate set. Only indexes that opt in (filteredSearch) receive it; others post-filter as before.
			const recordFilter = index.customIndex.filteredSearch ? searchCondition.recordFilter : undefined;
			const candidateKeys = index.customIndex.candidateKeyFilter ? (searchCondition as any).candidateKeys : undefined;
			const waiting = index.customIndex.filePrimary && searchCondition.waitForIndexMilliseconds > 0;
			const start = waiting ? Promise.withResolvers<void>() : undefined;
			const controller = waiting ? new AbortController() : undefined;
			const checkActive = waiting ? getReadTransactionGuard(transaction) : undefined;
			const signal = waiting
				? context.signal
					? AbortSignal.any([context.signal, controller.signal])
					: controller.signal
				: undefined;
			const indexSearchStart = waiting ? start.promise.then(() => checkActive?.()) : undefined;
			indexSearchStart?.catch(() => {});
			const searchContext = waiting
				? Object.create(context, {
						signal: { value: signal },
						indexSearchStart: { value: indexSearchStart },
					})
				: context;
			const searched = index.customIndex.search(searchCondition, searchContext, {
				filter:
					waiting && recordFilter
						? (id, entry) => {
								if (signal.aborted) return false;
								checkActive?.();
								return recordFilter(id, entry);
							}
						: recordFilter,
				minResults,
				resultOffset,
				assertTransactionActive: checkActive,
				candidateKeys,
			});
			const coverage = (searched as any).indexCoverage;
			if (!waiting && coverage && context?.responseHeaders) {
				appendHeader(
					context.responseHeaders,
					'Harper-Index-Coverage',
					`${coverage.state}; lag=${coverage.lagUpperBoundMilliseconds}; tolerance=${coverage.maxLagMilliseconds}`,
					true
				);
				appendHeader(context.responseHeaders, 'Access-Control-Expose-Headers', 'Harper-Index-Coverage', true);
			}
			const processEntries = (entries: any[]) => {
				const loaded = entries
					.map((entry) => {
						// if the custom index returns an entry with metadata, merge it with the loaded entry
						if (typeof entry === 'object' && entry) {
							const { key, loadedEntry: suppliedEntry, ...otherProps } = entry;
							if (key == null) return SKIP; // primaryKey missing from HNSW node — skip rather than crash
							const loadedEntry =
								suppliedEntry ??
								Table.primaryStore.getEntry(key, {
									transaction: waiting ? transaction : context && Table._readTxnForContext(context),
								});
							if (!loadedEntry) return SKIP; // record was deleted/expired or not yet visible
							freezeRecord(loadedEntry?.value);
							recordRead(loadedEntry);
							return { ...otherProps, ...loadedEntry };
						}
						return entry;
					})
					.filter((entry) => entry !== SKIP);
				if (index.customIndex.rescoreResults) {
					const rescored = index.customIndex.rescoreResults(loaded, searchCondition, comparator, attribute_name);
					if (rescored != null) return rescored as any;
				}
				return loaded;
			};
			if (typeof (searched as any)?.then === 'function') {
				let settled = false;
				const pending = waiting
					? (searched as Promise<any[]>)
							.then((entries) => {
								if (controller.signal.aborted) return [];
								if (signal.aborted) throw signal.reason ?? new Error('Index search aborted', { cause: signal.reason });
								checkActive?.();
								return processEntries(entries);
							})
							.finally(() => {
								settled = true;
							})
					: (searched as Promise<any[]>).then(processEntries);
				// A consumer may abandon this lazy iterable without calling next().
				pending.catch(() => {});
				const results: any = new ExtendedIterable();
				results.iterate = (options?: { async?: boolean }) => {
					if (!options?.async) {
						throw new Error(
							'This index resolves search results asynchronously; the results must be consumed with async iteration'
						);
					}
					// Overlapping next() calls share one cursor and cannot duplicate its first entry.
					const iteratorPromise = pending.then((entries) => entries[Symbol.iterator]());
					iteratorPromise.catch(() => {});
					let closed = false;
					return {
						next() {
							if (closed) return Promise.resolve({ done: true, value: undefined });
							start?.resolve();
							return iteratorPromise.then((inner) => {
								if (closed) return { done: true, value: undefined };
								checkActive?.();
								return inner.next();
							});
						},
						return(value?: any) {
							closed = true;
							if (!settled) {
								start?.resolve();
								controller?.abort();
							}
							iteratorPromise.then(
								(inner) => (inner as any).return?.(value),
								() => {}
							);
							return Promise.resolve({ done: true, value });
						},
					};
				};
				return results;
			}
			return processEntries(searched);
		}
		const scanned = index.getRange(rangeOptions).map(
			filter
				? function ({ key, value }) {
						let recordMatcher: any;
						if (typeof key === 'string' && key.length > MAX_SEARCH_KEY_LENGTH) {
							// if it is an overflow string, need to get the actual value from the database
							recordMatcher = Table.primaryStore.getSync(value);
						} else recordMatcher = { [attribute_name]: key };
						if (this.isSync) return filter(recordMatcher) ? value : SKIP;
						// for filter operations, we intentionally yield the event turn so that scanning queries
						// do not hog resources
						return new Promise((resolve, reject) =>
							setImmediate(() => {
								try {
									resolve(filter(recordMatcher) ? value : SKIP);
								} catch (error) {
									reject(error);
								}
							})
						);
					}
				: ({ value }) => value
		);
		// Collapsing AFTER the map is required, not incidental: the condition's own filter tests one
		// element at a time, so a record whose first entry fails it and whose second passes must
		// still be reached. Collapsing first would settle that record on the failing entry and drop
		// it. Scoped to attributes the schema declares multi-valued; a runtime array under an
		// undeclared attribute repeats the same way but stays outside this boundary.
		return scansOneIndexedValue || !findAttribute(Table.attributes, attribute_name)?.elements
			? scanned
			: distinctRecords(scanned);
	} else {
		return Table.primaryStore
			.getRange(reverse ? { end: true, transaction, reverse: true } : { start: true, transaction })
			.map(function (entry) {
				const { key, value } = entry;
				if (this.isSync) {
					recordRead(entry);
					return value && filter(value) ? key : SKIP;
				}
				// for filter operations, we intentionally yield the event turn so that scanning queries
				// do not hog resources
				return new Promise((resolve, reject) =>
					setImmediate(() => {
						try {
							recordRead(entry);
							resolve(value && filter(value) ? key : SKIP);
						} catch (error) {
							reject(error);
						}
					})
				);
			});
	}
	function recordRead(entry) {
		if ((Table.databaseName !== 'system' || Table.name === 'hdb_analytics') && entry?.value) {
			recordAction(entry.size ?? 1, 'db-read', Table.name, null);
		}
	}
}

export function findAttribute(attributes, attribute_name) {
	if (Array.isArray(attribute_name)) {
		if (attribute_name.length > 1) {
			const firstAttribute = findAttribute(attributes, attribute_name[0]);
			const nextAttributes =
				(firstAttribute?.definition?.tableClass || firstAttribute?.elements?.definition?.tableClass)?.attributes ??
				firstAttribute?.properties;
			if (nextAttributes) return findAttribute(nextAttributes, attribute_name.slice(1));
			return;
		} else attribute_name = attribute_name.toString();
	} else if (typeof attribute_name !== 'string') attribute_name = attribute_name.toString();
	return attributes.find((attribute) => attribute.name === attribute_name);
}

/**
 * This is used to join the results of a query where the right side is a set of records with the foreign key that
 * points to the left side (from right to left)
 * @param rightIterable
 * @param attribute
 * @param store
 * @param isManyToMany
 * @param joined
 * @param transaction the read handle the right side was scanned with
 * @returns
 */
function joinTo(rightIterable, attribute, store, isManyToMany, joined: Map<any, any[]>, transaction) {
	const rightProperty = attribute.relationship.to;
	const addEntry = (key, entry) => {
		let entriesForKey = joined.get(key);
		if (entriesForKey) entriesForKey.push(entry);
		else joined.set(key, (entriesForKey = [entry]));
	};
	const addRelated = (entry, record) => {
		const leftKey = record?.[rightProperty];
		if (leftKey == null) return;
		if (isManyToMany) {
			for (let i = 0; i < leftKey.length; i++) {
				addEntry(leftKey[i], entry);
			}
		} else {
			addEntry(leftKey, entry);
		}
	};
	const results = new ExtendedIterable();
	results.iterate = (options) => {
		let joinedIterator;
		(joined as any).hasMappings = true;
		if (options?.async) {
			const scan: JoinScan = { closed: false, transaction, checkActive: getReadTransactionGuard(transaction) };
			let scanned: Promise<void>;
			const readOptions = { transaction, async: true };
			return {
				next() {
					if (scanStopped(scan)) return { done: true, value: undefined };
					if (joinedIterator) return joinedIterator.next();
					scanned ??= scanRelated(
						rightIterable,
						(entry) => entry.value ?? when(store.getEntry(entry.key ?? entry, readOptions), entryValue),
						joined,
						addRelated,
						scan
					).then(() => {
						joinedIterator = (scanStopped(scan) ? new Map() : joined).keys()[Symbol.iterator]();
					});
					return scanned.then(() => (scanStopped(scan) ? { done: true, value: undefined } : joinedIterator.next()));
				},
				return() {
					scan.closed = true;
					return { done: true, value: undefined };
				},
			};
		}
		const readOptions = { transaction };
		return {
			next() {
				if (!joinedIterator) {
					//let i = 0;
					// get all the ids of the related records
					for (const entry of rightIterable) {
						const record = entry.value ?? store.getSync(entry.key ?? entry, readOptions);
						if (record != null && (joined as any).filters?.some((filter) => !filter(record))) continue;
						addRelated(entry, record);
						// TODO: Enable this with async iterator manually iterating so that we don't need to do an await on every iteration
						/*
						if (i++ > 100) {
							// yield the event turn every 100 ids. See below for more explanation
							await new Promise(setImmediate);
							i = 0;
						}*/
					}
					joinedIterator = joined.keys()[Symbol.iterator]();
				}
				return joinedIterator.next();
			},
			return() {
				return { done: true, value: undefined };
			},
		};
	};
	return results;
}
const entryValue = (entry) => entry?.value;
function ignoreReturnFailure() {}
// when a later call throws, the earlier pending results are observed so their rejections are not reported unhandled
function mapSettlingOnThrow(items: any[], map: (item: any) => any) {
	const results = [];
	try {
		for (const item of items) results.push(map(item));
	} catch (error) {
		Promise.all(results).catch(ignoreReturnFailure);
		throw error;
	}
	return results;
}
// see the sorted iterator's stopped() in Table.transformToOrderedSelect
function scanStopped(scan: JoinScan) {
	if (scan.closed) return true;
	scan.checkActive?.();
	return scan.transaction?.isDone;
}
type JoinScan = { closed: boolean; transaction: any; checkActive?: () => void };
async function scanRelated(rightIterable, readRecord, joined, add, scan: JoinScan, joinsByKey?: boolean) {
	// a custom index search can return a plain array
	const iterator = (rightIterable[Symbol.asyncIterator] ?? rightIterable[Symbol.iterator]).call(rightIterable);
	const filters = (joined as any).filters;
	let done = false;
	try {
		while (!scanStopped(scan)) {
			let iteration = iterator.next();
			if (iteration.then) {
				iteration = await iteration;
				if (scanStopped(scan)) return;
			}
			if (iteration.done) {
				done = true;
				return;
			}
			const entry = iteration.value;
			if (joinsByKey && filters && rejectsKey(filters, entry.key ?? entry)) continue;
			let record = !joinsByKey || (filters && needsRecord(filters)) ? readRecord(entry) : undefined;
			if (record?.then) {
				record = await record;
				if (scanStopped(scan)) return;
			}
			if (filters) {
				let matches = matchesRelatedRecord(filters, record, joinsByKey, scan);
				if (matches?.then) {
					matches = await matches;
					if (scanStopped(scan)) return;
				}
				if (!matches) continue;
			}
			add(entry, record);
		}
	} finally {
		// a close that throws (likeliest right after a snapshot is released) must not replace the scan's error
		if (!done)
			try {
				iterator.return?.()?.catch?.(ignoreReturnFailure);
			} catch {}
	}
}
class RelationshipSelection {
	filters: any[];
	fromRecord: (record: any, sync?: boolean) => any;
	constructor(filters: any[], fromRecord: (record: any, sync?: boolean) => any) {
		this.filters = filters;
		this.fromRecord = fromRecord;
	}
}
// keys the join and selection maps keep for themselves, so a relationship of that name cannot be tracked in them
const SELECTION_BOOKKEEPING = new Set(['filters', 'fromRecord', 'hasMappings']);
// A query's `filtered` map holds, per relationship name, a leading join's Map or a selection with `fromRecord`.
// Read it as an own property of that shape: a name can equal an inherited member or the maps' bookkeeping keys.
export function relationshipRestriction(filtered, name: string) {
	const restriction = filtered && Object.hasOwn(filtered, name) ? filtered[name] : undefined;
	return restriction instanceof Map || typeof restriction?.fromRecord === 'function' ? restriction : undefined;
}
function someRelatedMatch(entries, match, start: number) {
	for (let i = start; i < entries.length; i++) {
		const value = entries[i]?.value;
		if (value == null) continue;
		const matches = match(value);
		if (matches?.then) return matches.then((matches) => matches || someRelatedMatch(entries, match, i + 1));
		if (matches) return true;
	}
	return false;
}
export function matchesFilters(filters, record, entry, any: boolean, start = 0) {
	for (let i = start; i < filters.length; i++) {
		const filter = filters[i];
		const matches = (filter.maybeAsync ?? filter)(record, entry);
		if (matches?.then)
			return matches.then((matches) =>
				(any ? matches : !matches) ? any : matchesFilters(filters, record, entry, any, i + 1)
			);
		if (any ? matches : !matches) return any;
	}
	return !any;
}
// read per candidate, since a content filter can switch to an index-backed idFilter mid-scan
function rejectsKey(filters, key) {
	for (let i = 0; i < filters.length; i++) {
		const idFilter = filters[i].idFilter;
		if (idFilter && !idFilter(key)) return true;
	}
	return false;
}
function needsRecord(filters) {
	for (let i = 0; i < filters.length; i++) if (!filters[i].idFilter) return true;
	return false;
}
function matchesRelatedRecord(filters, record, skipIdFilters: boolean, scan: JoinScan, start = 0) {
	for (let i = start; i < filters.length; i++) {
		const filter = filters[i];
		if (skipIdFilters && filter.idFilter) continue;
		if (record == null) return false;
		const matches = (filter.maybeAsync ?? filter)(record);
		if (matches?.then)
			return matches.then(
				(matches) => matches && !scanStopped(scan) && matchesRelatedRecord(filters, record, skipIdFilters, scan, i + 1)
			);
		if (!matches) return false;
	}
	return true;
}
/**
 * This is used to join the results of a query where the right side is a set of ids and the left side is a set of records
 * that have the foreign key (from left to right)
 * @param rightIterable
 * @param attribute
 * @param store
 * @param joined
 * @param searchEntry
 * @param transaction the read handle the right side was scanned with
 * @returns
 */
function joinFrom(rightIterable, attribute, store, joined: Map<any, any[]>, searchEntry, transaction) {
	const results = new ExtendedIterable();
	results.iterate = (options) => {
		let idIterator;
		let joinedIterator;
		const seenIds = new Set();
		// get the ids of the related records as a Set so we can quickly check if it is in the set
		// when are iterating through the results
		const ids = new Set();
		// Define the fromRecord function so that we can use it to filter the related records
		// that are in the select(), to only those that are in this set of ids
		const defineFromRecord = () => {
			(joined as any).fromRecord = (record) => {
				// TODO: Sort based on order ids
				return record[attribute.relationship.from]?.filter?.((id) => ids.has(id));
			};
		};
		const nextJoined = () => {
			while (true) {
				if (joinedIterator) {
					while (true) {
						const joinedEntry = joinedIterator.next();
						if (joinedEntry.done) break; // and continue to find next
						const id = joinedEntry.value;
						if (seenIds.has(id)) continue;
						seenIds.add(id);
						return joinedEntry;
					}
				}
				const idEntry = idIterator.next();
				if (idEntry.done) return idEntry;
				joinedIterator = searchEntry(idEntry.value)[Symbol.iterator]();
			}
		};
		const scan: JoinScan = { closed: false, transaction, checkActive: getReadTransactionGuard(transaction) };
		const iterator: any = {
			return() {
				scan.closed = true;
				joinedIterator?.return?.();
				return { done: true, value: undefined };
			},
			throw() {
				scan.closed = true;
				return joinedIterator?.throw?.();
			},
		};
		if (options?.async) {
			let scanned: Promise<void>;
			const readOptions = { transaction, async: true };
			iterator.next = () => {
				if (scanStopped(scan)) return { done: true, value: undefined };
				if (idIterator) return nextJoined();
				if (!scanned) {
					defineFromRecord();
					scanned = scanRelated(
						rightIterable,
						(entry) =>
							entry.value !== undefined
								? entry.value
								: when(store.getEntry(entry.key ?? entry, readOptions), entryValue),
						joined,
						(entry) => ids.add(entry.key ?? entry),
						scan,
						true
					).then(() => {
						idIterator = (scanStopped(scan) ? new Set() : ids)[Symbol.iterator]();
					});
				}
				return scanned.then(() => (scanStopped(scan) ? { done: true, value: undefined } : nextJoined()));
			};
		} else {
			const readOptions = { transaction };
			iterator.next = () => {
				if (!idIterator) {
					defineFromRecord();
					//let i = 0;
					// get all the ids of the related records
					const filters = (joined as any).filters;
					for (const entry of rightIterable) {
						const id = entry.key ?? entry;
						if (filters) {
							if (rejectsKey(filters, id)) continue;
							if (needsRecord(filters)) {
								const record = entry.value !== undefined ? entry.value : store.getSync(id, readOptions);
								let matches = record != null;
								for (let i = 0; matches && i < filters.length; i++)
									if (!filters[i].idFilter) matches = filters[i](record);
								if (!matches) continue;
							}
						}
						ids.add(id);
						// TODO: Re-enable this when async iteration is used, and do so with manually iterating so that we don't need to do an await on every iteration
						/*
						if (i++ > 100) {
							// yield the event turn every 100 ids. We don't want to monopolize the
							// event loop, give others a chance to run. However, we are much more aggressive
							// about running here than in simple filter operations, because we are
							// executing a very minimal range iteration and because this is consuming
							// memory (so we want to get it over with) and the user isn't getting any
							// results until we finish
							await new Promise(setImmediate);
							i = 0;
						}*/
					}
					// and now start iterating through the ids
					idIterator = ids[Symbol.iterator]();
				}
				return nextJoined();
			};
		}
		return iterator;
	};
	return results;
}

export const ALTERNATE_COMPARATOR_NAMES = {
	'eq': 'equals',
	'greater_than': 'gt',
	'greaterThan': 'gt',
	'greater_than_equal': 'ge',
	'greaterThanEqual': 'ge',
	'less_than': 'lt',
	'lessThan': 'lt',
	'less_than_equal': 'le',
	'lessThanEqual': 'le',
	'not_equal': 'ne',
	'notEqual': 'ne',
	'equal': 'equals',
	'sw': 'starts_with',
	'startsWith': 'starts_with',
	'ew': 'ends_with',
	'endsWith': 'ends_with',
	'ct': 'contains',
	'includes': 'in',
	'>': 'gt',
	'>=': 'ge',
	'<': 'lt',
	'<=': 'le',
	'...': 'between',
};

// Canonical comparators whose value is a list (array) of values. Used to recognize the
// REST `(v1,v2,...)` value syntax during parsing.
const LIST_VALUE_COMPARATORS = new Set(['in', 'between', 'gele', 'gelt', 'gtlt', 'gtle']);

// Base comparators that accept the `not_` prefix to produce a negated form.
// `not_equal` is an existing alias for `ne` and keeps its existing semantics.
const NEGATABLE_BASE_COMPARATORS = new Set([
	'in',
	'between',
	'starts_with',
	'ends_with',
	'contains',
	'equals',
	...FULL_TEXT_POSITIVE_COMPARATORS,
]);

/**
 * Resolve a comparator name to a (possibly stripped) base comparator and a
 * `negated` flag. Existing aliases are preserved as-is — the execution layer
 * resolves them via `ALTERNATE_COMPARATOR_NAMES`. Only the `not_` prefix is
 * stripped here, and only when the base is a recognized negatable comparator
 * and the full name is not itself an existing alias (so `not_equal` keeps its
 * historical mapping to `ne`).
 */
export function resolveComparator(comparator: string | undefined): {
	comparator: string | undefined;
	negated: boolean;
} {
	if (comparator == null) return { comparator, negated: false };
	// Preserve existing aliases (e.g., `not_equal` -> `ne`) — let execution-time
	// alias resolution handle them so we don't change comparator strings stored
	// on the condition object.
	if (ALTERNATE_COMPARATOR_NAMES[comparator]) return { comparator, negated: false };
	if (typeof comparator === 'string' && comparator.startsWith('not_')) {
		const base = comparator.slice(4);
		const baseResolved = ALTERNATE_COMPARATOR_NAMES[base] || base;
		if (NEGATABLE_BASE_COMPARATORS.has(baseResolved)) {
			return { comparator: base, negated: true };
		}
	}
	return { comparator, negated: false };
}

function rangeBounds(comparator: string, value: any) {
	if (!Array.isArray(value) || value.length !== 2)
		throw new ClientError(`"${comparator}" comparator requires a two-element array value`);
}

/**
 * Walk a nested-property path on a record. Returns the value at the path,
 * or undefined if any intermediate property is missing.
 */
export function getNestedValue(record: any, path: string | string[]): any {
	if (typeof path === 'string') return record?.[path];
	let current = record;
	for (let i = 0; i < path.length; i++) {
		if (current == null) return undefined;
		current = current[path[i]];
	}
	return current;
}

/**
 * Create a filter based on the search condition that can be used to test each supplied record.
 * @param {SearchObject} searchCondition
 * @returns {({}) => boolean}
 */
export function filterByType(
	searchCondition,
	Table,
	context,
	filtered,
	isPrimaryKey?,
	estimatedIncomingCount?,
	inUnion?: boolean
) {
	const comparator = searchCondition.comparator;
	const negated = searchCondition.negated;
	let attribute = searchCondition[0] ?? searchCondition.attribute;
	let value = searchCondition[1] ?? searchCondition.value;
	if (Array.isArray(attribute)) {
		if (attribute.length === 0) return () => true;
		if (attribute.length === 1) {
			attribute = attribute[0];
			isPrimaryKey = attribute === Table?.primaryKey;
		} else if (attribute.length > 1) {
			const firstAttributeName = attribute[0];
			// get the relationship attribute (may be undefined for plain JSON paths)
			const firstAttribute = findAttribute(Table?.attributes, firstAttributeName);
			const relatedTable = firstAttribute?.definition?.tableClass || firstAttribute?.elements?.definition?.tableClass;
			if (!relatedTable) {
				// Plain JSON nested path — walk the path on each record. Array
				// intermediates use `some` semantics (match if any element matches).
				const restAttribute = attribute.length > 2 ? attribute.slice(1) : attribute[1];
				const leafFilter = filterByType(
					{ attribute: restAttribute, value, comparator, negated },
					NESTED_PATH_TABLE,
					context,
					null,
					false,
					estimatedIncomingCount
				);
				if (!leafFilter) return;
				return function nestedRecordFilter(record, entry) {
					const subObject = record?.[firstAttributeName];
					if (subObject == null) return leafFilter(undefined, entry);
					if (Array.isArray(subObject)) return subObject.some((item) => leafFilter(item, entry));
					return leafFilter(subObject, entry);
				};
			}
			// TODO: If this is a relationship, we can potentially make this more efficient by using the index
			// and retrieving the set of matching ids first
			const filterMap = relationshipRestriction(filtered, firstAttributeName);
			const join: any = filterMap instanceof Map ? filterMap : undefined;
			const resolver = Table.propertyResolvers?.[firstAttributeName];
			const loadEntries = resolver?.loadEntries;
			const getSubObject = (record, entry) => {
				let subObject, subEntry, subEntries;
				if (resolver) {
					if (resolver.returnDirect) {
						// indicates that the resolver will direct return the value instead of an entry
						subObject = resolver(record, context, entry);
						subEntry = lastMetadata;
					} else {
						subEntry = resolver(record, context, entry, true);
						if (Array.isArray(subEntry)) {
							subEntries = subEntry.filter((related) => related?.value != null);
							subObject = subEntries.map((related) => related.value);
							subEntry = null;
						} else {
							subObject = subEntry?.value;
						}
					}
				} else subObject = record[firstAttributeName];
				return { subObject, subEntry, subEntries };
			};
			const relatedSelection = (filters: any[]) =>
				new RelationshipSelection(filters, (record, sync?: boolean) => {
					// this is called when selecting the fields to include in results
					if (loadEntries && !sync) {
						return when(loadEntries(record, context), (loaded) => {
							if (!resolver.toMany || !loaded) return loaded?.value;
							const matches = mapSettlingOnThrow(
								loaded,
								(entry) => entry?.value != null && matchesFilters(filters, entry.value, entry, false)
							);
							const matchingKeys = (matches) =>
								loaded
									.filter((_entry, i) => matches[i])
									.map((entry) => entry.key ?? entry.value[relatedTable.primaryKey]);
							return matches.some((matches) => matches?.then)
								? Promise.all(matches).then(matchingKeys)
								: matchingKeys(matches);
						});
					}
					const { subObject, subEntries } = getSubObject(record, undefined);
					if (!Array.isArray(subObject)) return subObject;
					const keys = [];
					for (let i = 0; i < subObject.length; i++) {
						const value = subObject[i];
						const entry = subEntries?.[i];
						if (filters.every((filter) => filter(value, entry)))
							keys.push(entry?.key ?? value[relatedTable.primaryKey]);
					}
					return keys;
				});
			// AND scope: registered when built, so no row sees a partial set; OR scope: lazily, first branch wins
			const restrictsSelect = filtered && firstAttribute.elements && !SELECTION_BOOKKEEPING.has(firstAttributeName);
			let selection;
			if (!join && restrictsSelect && !inUnion) {
				if (filterMap instanceof RelationshipSelection) selection = filterMap;
				else if (!Object.hasOwn(filtered, firstAttributeName)) selection = relatedSelection([]);
			}
			const nextFilter = filterByType(
				{
					attribute: attribute.length > 2 ? attribute.slice(1) : attribute[1],
					value,
					comparator,
					negated,
				},
				relatedTable,
				context,
				join ?? selection,
				attribute[1] === relatedTable.primaryKey,
				estimatedIncomingCount,
				inUnion
			);
			if (!nextFilter) return;
			if (join) {
				if (!join.filters) join.filters = [];
				join.filters.push(nextFilter);
				return;
			}
			if (selection) {
				filtered[firstAttributeName] = selection;
				selection.filters.push(nextFilter);
			}
			if (resolver?.to) nextFilter.to = resolver.to;
			let subIdFilter;
			// the shortcut tests this record's `from` (or key): a `to` relationship's id filter must be mapped through `to`
			const usesIdFilter = () => nextFilter.idFilter && (!resolver.to || nextFilter.idFilter.mappedTo);
			const preserveForSelect = () => {
				if (inUnion && restrictsSelect && !Object.hasOwn(filtered, firstAttributeName))
					filtered[firstAttributeName] = relatedSelection([nextFilter]);
			};
			const recordFilter = (record, entry) => {
				if (resolver && usesIdFilter()) {
					// if we are filtering by id, we can use the idFilter to avoid loading the record
					if (!subIdFilter) {
						// an array of foreign keys is tested per element; a single key (which may be a composite array) whole
						const allowObjectMatching = Boolean(resolver.to) || !resolver.toMany;
						if (nextFilter.idFilter.idSet?.size === 1) {
							// if there is a single id we are looking for, we can create a new search condition that the
							// attribute comparator could eventually use to create a recursive id set
							// TODO: Eventually we should be able to handle multiple ids by creating a union
							searchCondition = {
								attribute: resolver.from ?? Table.primaryKey, // if no from, we use our primary key
								value: nextFilter.idFilter.onlyId,
							};
							subIdFilter = attributeComparator(
								resolver.from ?? Table.primaryKey,
								nextFilter.idFilter,
								true,
								allowObjectMatching
							);
						} else
							subIdFilter = attributeComparator(
								resolver.from ?? Table.primaryKey,
								nextFilter.idFilter,
								false,
								allowObjectMatching
							);
					}
					const matches = subIdFilter(record);
					if ((subIdFilter as any).idFilter) (recordFilter as any).idFilter = (subIdFilter as any).idFilter;
					if (matches) preserveForSelect();
					return matches;
				}
				const { subObject, subEntry, subEntries } = getSubObject(record, entry);
				if (!subObject) return false;
				if (!Array.isArray(subObject)) return nextFilter(subObject, subEntry);
				preserveForSelect();
				return subObject.some((value, i) => nextFilter(value, subEntries?.[i]));
			};
			const nextMatch = nextFilter.maybeAsync ?? nextFilter;
			if (loadEntries) {
				const matchLoaded = (loaded) => {
					if (!resolver.toMany) return loaded?.value ? nextMatch(loaded.value, loaded) : false;
					if (!loaded) return false;
					preserveForSelect();
					return someRelatedMatch(loaded, nextMatch, 0);
				};
				(recordFilter as any).maybeAsync = (record, entry) => {
					if (usesIdFilter()) return recordFilter(record, entry);
					const loaded = loadEntries(record, context);
					return loaded?.then ? loaded.then(matchLoaded) : matchLoaded(loaded);
				};
			}
			return recordFilter;
		}
	}
	if (value instanceof Date) value = value.getTime();

	let baseFilter;
	switch (ALTERNATE_COMPARATOR_NAMES[comparator] || comparator) {
		case SEARCH_TYPES.EQUALS:
		case undefined:
			baseFilter = attributeComparator(
				attribute,
				isPrimaryKey ? primaryKeyEquals(value) : (recordValue) => recordValue === value,
				true
			);
			break;
		case 'contains':
			baseFilter = attributeComparator(attribute, (recordValue) => recordValue?.toString().includes(value));
			break;
		case 'ends_with':
			baseFilter = attributeComparator(attribute, (recordValue) => recordValue?.toString().endsWith(value));
			break;
		case 'starts_with': {
			const prefix = String(value);
			const encodedPrefix = isPrimaryKey && prefix ? (writeKeyId(prefix) as string) : undefined;
			baseFilter = attributeComparator(
				attribute,
				(recordValue) => {
					if (typeof recordValue === 'string') return recordValue.startsWith(prefix);
					if (!isPrimaryKey || !Array.isArray(recordValue)) return false;
					if (encodedPrefix !== undefined) return (writeKeyId(recordValue) as string).startsWith(encodedPrefix);
					// a one-element tuple decodes as its element, so this is the test that element would get
					let leading = recordValue[0];
					while (Array.isArray(leading)) leading = leading[0];
					return typeof leading === 'string';
				},
				true
			);
			break;
		}
		case 'prefix': {
			if (!Array.isArray(value)) value = [value];
			else if (value[value.length - 1] == null) value = value.slice(0, -1);
			// the primary-store scan reads [...value, null] up to [...value, MAXIMUM_KEY]
			const encodedPrefix = isPrimaryKey ? (value.length > 0 ? (writeKeyId(value) as string) + '\x00' : '') : undefined;
			baseFilter = attributeComparator(
				attribute,
				(recordValue) => {
					if (encodedPrefix !== undefined)
						return recordValue != null && (writeKeyId(recordValue) as string).startsWith(encodedPrefix);
					if (!Array.isArray(recordValue)) return false;
					for (let i = 0, l = value.length; i < l; i++) {
						if (recordValue[i] !== value[i]) return false;
					}
					return true;
				},
				true
			);
			break;
		}
		case 'between':
		case 'gele':
		case 'gtlt':
		case 'gtle':
		case 'gelt': {
			rangeBounds(comparator, value);
			if (value[0] instanceof Date) value[0] = value[0].getTime();
			if (value[1] instanceof Date) value[1] = value[1].getTime();
			const resolvedComparator = ALTERNATE_COMPARATOR_NAMES[comparator] || comparator;
			const startInclusive =
				resolvedComparator === 'between' || resolvedComparator === 'gele' || resolvedComparator === 'gelt';
			const endInclusive =
				resolvedComparator === 'between' || resolvedComparator === 'gele' || resolvedComparator === 'gtle';
			baseFilter = attributeComparator(
				attribute,
				(recordValue) => {
					if (recordValue === undefined) return false;
					const cmpStart = compareKeys(recordValue, value[0]);
					const cmpEnd = compareKeys(recordValue, value[1]);
					return (startInclusive ? cmpStart >= 0 : cmpStart > 0) && (endInclusive ? cmpEnd <= 0 : cmpEnd < 0);
				},
				true
			);
			break;
		}
		case 'in': {
			if (!Array.isArray(value)) throw new ClientError(`"in" comparator requires an array value`);
			// Cache the Set on the condition so multi-row evaluation reuses it.
			let valueSet: Set<any> | CandidateKeySet = (searchCondition as any).cachedSet;
			if (!valueSet) {
				const values = value.map((v) => (v instanceof Date ? v.getTime() : v));
				if (isPrimaryKey) {
					valueSet = new CandidateKeySet();
					for (const key of values) valueSet.add(key);
				} else valueSet = new Set(values);
				(searchCondition as any).cachedSet = valueSet;
			}
			baseFilter = attributeComparator(attribute, (recordValue) => valueSet.has(recordValue), true);
			break;
		}
		// no index holds an entry for an omitted (undefined) value
		case 'gt':
			baseFilter = attributeComparator(
				attribute,
				(recordValue) => recordValue !== undefined && compareKeys(recordValue, value) > 0
			);
			break;
		case 'ge':
			baseFilter = attributeComparator(
				attribute,
				(recordValue) => recordValue !== undefined && compareKeys(recordValue, value) >= 0
			);
			break;
		case 'lt':
			baseFilter = attributeComparator(
				attribute,
				(recordValue) => recordValue != null && compareKeys(recordValue, value) < 0
			);
			break;
		case 'le':
			baseFilter = attributeComparator(
				attribute,
				(recordValue) => recordValue != null && compareKeys(recordValue, value) <= 0
			);
			break;
		case 'ne': {
			if (isPrimaryKey) {
				const equals = primaryKeyEquals(value);
				baseFilter = attributeComparator(attribute, (primaryKey) => !equals(primaryKey));
			} else
				baseFilter = attributeComparator(
					attribute,
					(recordValue) => compareKeys(recordValue ?? null, value) !== 0,
					false,
					true
				);
			break;
		}
		case 'sort':
			return () => true;
		default:
			throw new ClientError(`Unknown query comparator "${comparator}"`);
	}
	if (negated && baseFilter) {
		// Wrap with negation. Internal index-optimization state on `baseFilter`
		// (idFilter, to, etc.) is intentionally not propagated through the
		// negation wrapper — negated conditions are filter-only in Phase 1.
		return (record, entry) => !baseFilter(record, entry);
	}
	return baseFilter;
	/** Create a comparison function that can take the record and check the attribute's value with the filter function */
	function attributeComparator(
		attribute: string,
		filter: (record: any) => boolean,
		canUseIndex?: boolean,
		allowObjectMatching?: boolean
	) {
		let thresholdRemainingMisses: number;
		allowObjectMatching ||= isPrimaryKey;
		canUseIndex =
			canUseIndex && // is it a comparator that makes sense to use index
			!isPrimaryKey && // no need to use index for primary keys, since we will be iterating over the primary keys
			!!(Table && usableIndex(Table, attribute)) && // is there a usable (complete) index for this attribute
			estimatedIncomingCount > 3; // do we have a valid estimate of multiple incoming records (that is worth using an index for)
		if (canUseIndex) {
			if (searchCondition.estimated_count == undefined) estimateCondition(Table)(searchCondition);
			thresholdRemainingMisses = searchCondition.estimated_count >> 4;
			if (isNaN(thresholdRemainingMisses) || thresholdRemainingMisses >= estimatedIncomingCount)
				// invalid or can't be ever reached
				canUseIndex = false;
		}
		let misses = 0;
		let filteredSoFar = 3; // what we use to calculate miss rate; we give some buffer so we don't jump to indexed retrieval too quickly
		function recordFilter(record: any) {
			// `record` may be null/undefined when called via a nested-path filter
			// where an intermediate property is missing.
			const value = record == null ? undefined : record[attribute];
			let matches: boolean;
			if (typeof value !== 'object' || !value || allowObjectMatching) matches = filter(value);
			else if (Array.isArray(value)) matches = value.some(filter);
			else if (value instanceof Date) matches = filter(value.getTime());
			//else matches = false;
			// As we are filtering, we can lazily/reactively switch to indexing if we are getting a low match rate, allowing use to load
			// a set of ids instead of loading each record. This can be a significant performance improvement for large queries with low match rates
			if (canUseIndex) {
				filteredSoFar++;
				if (
					!matches &&
					!recordFilter.idFilter &&
					// miss rate x estimated remaining to filter > 10% of estimated incoming
					(++misses / filteredSoFar) * estimatedIncomingCount > thresholdRemainingMisses
				) {
					// if we have missed too many times, we need to switch to indexed retrieval
					const searchResults = searchByIndex(searchCondition, Table._readTxnForContext(context), false, Table);
					let matchingIds: Iterable<Id>;
					if ((recordFilter as any).to) {
						// the values could be an array of keys, so we flatten the mapping
						matchingIds = (searchResults as any).flatMap(
							(id) => Table.primaryStore.getSync(id)[(recordFilter as any).to]
						);
					} else {
						matchingIds = searchResults as any;
					}
					// now generate a hash set that we can efficiently check primary keys against
					// TODO: Do this asynchronously
					const idSet = new CandidateKeySet();
					let firstId: Id | undefined;
					for (const id of matchingIds) {
						if (idSet.size === 0) firstId = id;
						idSet.add(id);
					}
					recordFilter.idFilter = (id) => idSet.has(id);
					(recordFilter.idFilter as any).idSet = idSet;
					// the set holds encoded identities; the singleton relationship lookup needs the key itself
					(recordFilter.idFilter as any).onlyId = idSet.size === 1 ? firstId : undefined;
					(recordFilter.idFilter as any).mappedTo = Boolean((recordFilter as any).to);
				}
			}
			return matches;
		}
		if (isPrimaryKey) {
			recordFilter.idFilter = filter;
		}
		return recordFilter;
	}
}

/**
 * Estimates a range comparator's entry count from the store's statistical estimate, blended with
 * the table-fraction heuristic by the estimate's confidence so low-confidence estimates degrade
 * to the old behavior. Returns undefined (caller falls back to the heuristic) when the store
 * cannot estimate, the shape is unexpected, or the executed range wouldn't match this one.
 */
function estimateRangeCondition(table, condition, searchType, fraction) {
	const attributeName = condition[0] ?? condition.attribute;
	const isPrimaryKey = attributeName === table.primaryKey;
	const store = isPrimaryKey ? table.primaryStore : usableIndex(table, attributeName);
	// LMDB-backed and custom index stores do not implement estimateCount
	if (typeof store?.estimateCount !== 'function') return undefined;
	let value = condition[1] ?? condition.value;
	if (value instanceof Date) value = value.getTime();
	let range;
	switch (searchType) {
		case 'lt':
			// mirrors searchByIndex: an indexNulls index's `[null, primaryKey]` entries are outside the executed range
			range = isPrimaryKey ? { start: true, end: value } : { start: null, exclusiveStart: true, end: value };
			break;
		case 'le':
			range = isPrimaryKey
				? { start: true, end: value, inclusiveEnd: true }
				: { start: null, exclusiveStart: true, end: value, inclusiveEnd: true };
			break;
		case 'gt':
			range = { start: value, exclusiveStart: true };
			break;
		case 'ge':
			range = { start: value };
			break;
		case 'between':
		case 'gele':
		case 'gelt':
		case 'gtlt':
		case 'gtle': {
			if (!Array.isArray(value)) return undefined;
			let [start, end] = value;
			if (start instanceof Date) start = start.getTime();
			if (end instanceof Date) end = end.getTime();
			range = {
				start,
				end,
				inclusiveEnd: searchType === 'between' || searchType === 'gele' || searchType === 'gtle',
				exclusiveStart: searchType === 'gtlt' || searchType === 'gtle',
			};
			break;
		}
		case 'starts_with': {
			const prefix = value?.toString();
			if (!prefix) return undefined;
			range = { start: prefix, end: getStringPrefixUpperBound(prefix) };
			break;
		}
		case 'prefix': {
			let start = Array.isArray(value) ? value : [value, null];
			if (start[start.length - 1] != null) start = start.concat(null);
			if (isPrimaryKey && start.length <= 1) {
				range = { start: true };
				break;
			}
			const end = start.slice(0);
			end[end.length - 1] = MAXIMUM_KEY;
			range = { start, end };
			break;
		}
		default:
			return undefined;
	}
	// Long string bounds get truncated + filtered at execution (searchByIndex), so the
	// executed range is wider than this one; don't estimate what won't be iterated.
	if (
		(typeof range.start === 'string' && range.start.length > MAX_SEARCH_KEY_LENGTH) ||
		(typeof range.end === 'string' && range.end.length > MAX_SEARCH_KEY_LENGTH)
	) {
		return undefined;
	}
	let count, confidence;
	try {
		({ count, confidence } = store.estimateCount(range) ?? {});
	} catch {
		// a concurrently closing/dropped store must degrade the plan, not fail the query
		return undefined;
	}
	if (!Number.isFinite(count) || count < 0 || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
		return undefined;
	const heuristic = fraction * estimatedEntryCount(table.primaryStore) + 1;
	return Math.max(1, Math.round(confidence * count + (1 - confidence) * heuristic));
}

/** The index a condition can be driven by; searchByIndex refuses a rebuilding one, so it reads as absent. */
function usableIndex(table, attributeName): any {
	const index = attributeName == null ? undefined : conditionIndex(table, attributeName);
	return index?.isIndexing ? undefined : index;
}

/**
 * True when an index this attribute would have to be driven by is still being built, following a
 * relationship path to the local join index and on to the related table's leaf index.
 */
function drivesRebuildingIndex(table, attributeName, relationshipOffset = 0): boolean {
	if (!Array.isArray(attributeName))
		return (
			attributeName != null && attributeName !== table.primaryKey && !!conditionIndex(table, attributeName)?.isIndexing
		);
	if (relationshipOffset >= attributeName.length - 1)
		return drivesRebuildingIndex(table, attributeName[relationshipOffset]);
	const attribute = findAttribute(table.attributes, attributeName[relationshipOffset]);
	if (!attribute) return false;
	if (table.indices[attribute.relationship?.from]?.isIndexing) return true;
	const relatedTable = attribute.definition?.tableClass || attribute.elements?.definition?.tableClass;
	return !!relatedTable && drivesRebuildingIndex(relatedTable, attributeName, relationshipOffset + 1);
}

export function estimateCondition(table) {
	function estimateConditionForTable(condition) {
		if (condition.estimated_count === undefined) {
			if (condition.conditions) {
				// for a group of conditions, we can estimate the count by combining the estimates of the sub-conditions
				let estimatedCount;
				if (condition.operator === 'or') {
					// with a union, we can just add the estimated counts
					estimatedCount = 0;
					for (const subCondition of condition.conditions) {
						estimateConditionForTable(subCondition);
						estimatedCount += subCondition.estimated_count;
					}
				} else {
					// with an intersection, we have to use the rate of the sub-conditions to apply to estimate count of last condition
					estimatedCount = Infinity;
					for (const subCondition of condition.conditions) {
						estimateConditionForTable(subCondition);
						estimatedCount = isFinite(estimatedCount)
							? (estimatedCount * subCondition.estimated_count) / (estimatedEntryCount(table.primaryStore) || 1)
							: subCondition.estimated_count;
					}
				}
				condition.estimated_count = estimatedCount;
				return condition.estimated_count;
			}
			// skip if it is cached
			let searchType = condition.comparator || condition.search_type;
			searchType = ALTERNATE_COMPARATOR_NAMES[searchType] || searchType;
			// before comparator dispatch: several branches fall back to a finite table-fraction heuristic
			if (drivesRebuildingIndex(table, condition[0] ?? condition.attribute)) {
				condition.estimated_count = Infinity;
			} else if (condition.negated) {
				// a negated condition always executes as a full scan (searchByIndex forces
				// needFullScan), so follow the filter-only convention used by contains/ends_with:
				// estimate Infinity so its positive-range estimate can never win the driving-condition
				// ordering. Short-circuit here rather than computing (and discarding) a positive-range
				// estimate that would cross the native FFI boundary for nothing.
				condition.estimated_count = Infinity;
			} else if (searchType === SEARCH_TYPES.EQUALS || !searchType) {
				const attribute_name = condition[0] ?? condition.attribute;
				if (attribute_name == null || attribute_name === table.primaryKey) condition.estimated_count = 1;
				else if (Array.isArray(attribute_name) && attribute_name.length > 1) {
					const attribute = findAttribute(table.attributes, attribute_name[0]);
					const relatedTable = attribute?.definition?.tableClass || attribute?.elements?.definition?.tableClass;
					if (!relatedTable) {
						// Plain JSON nested path — no index, can't estimate cheaply.
						condition.estimated_count = Infinity;
					} else {
						const estimate = estimateCondition(relatedTable)({
							value: condition.value,
							attribute: attribute_name.length > 2 ? attribute_name.slice(1) : attribute_name[1],
							comparator: 'equals',
						});
						const fromIndex = table.indices[attribute.relationship?.from];
						// the estimated count is sum of the estimate of the related table and the estimate of the index
						condition.estimated_count =
							estimate +
							(fromIndex
								? (estimate * estimatedEntryCount(table.indices[attribute.relationship.from])) /
									(estimatedEntryCount(relatedTable.primaryStore) || 1)
								: estimate);
					}
				} else {
					// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
					const index = usableIndex(table, attribute_name);
					condition.estimated_count = index ? index.getValuesCount(condition[1] ?? condition.value) : Infinity;
				}
			} else if (fullTextComparatorMode(searchType)) {
				const attributeName = condition[0] ?? condition.attribute;
				const index = conditionIndex(table, attributeName, true);
				condition.estimated_count = index?.customIndex?.estimateCount
					? index.customIndex.estimateCount(condition.value)
					: Infinity;
			} else if (searchType === 'contains' || searchType === 'ends_with' || searchType === 'ne') {
				const attribute_name = condition[0] ?? condition.attribute;
				const index = usableIndex(table, attribute_name);
				if (condition.value === null && searchType === 'ne') {
					condition.estimated_count = Math.max(
						estimatedEntryCount(table.primaryStore) - (index ? index.getValuesCount(null) : 0),
						0
					);
				} else condition.estimated_count = Infinity;
			} else if (searchType === 'in') {
				const attribute_name = condition[0] ?? condition.attribute;
				const index = usableIndex(table, attribute_name);
				if (Array.isArray(condition.value) && index) {
					// Sum of per-value matches (over-counts duplicates but is a fine ceiling)
					let estimate = 0;
					for (const item of condition.value) {
						estimate += index.getValuesCount(item);
					}
					condition.estimated_count = estimate;
				} else if (Array.isArray(condition.value)) {
					condition.estimated_count = Infinity;
				} else condition.estimated_count = Infinity;
			} else if (searchType === 'starts_with' || searchType === 'prefix')
				condition.estimated_count =
					estimateRangeCondition(table, condition, searchType, STARTS_WITH_ESTIMATE) ??
					STARTS_WITH_ESTIMATE * estimatedEntryCount(table.primaryStore) + 1;
			else if (searchType === 'between')
				condition.estimated_count =
					estimateRangeCondition(table, condition, searchType, BETWEEN_ESTIMATE) ??
					BETWEEN_ESTIMATE * estimatedEntryCount(table.primaryStore) + 1;
			else if (searchType === 'sort') {
				const attribute_name = condition[0] ?? condition.attribute;
				const index = usableIndex(table, attribute_name);
				if (index?.customIndex?.estimateCountAsSort)
					// allow custom index to define its own estimation of counts
					condition.estimated_count = index.customIndex.estimateCountAsSort(condition);
				else condition.estimated_count = estimatedEntryCount(table.primaryStore) + 1; // only used by sort
			} else {
				// for the search types that use the broadest range, try do them last
				const attribute_name = condition[0] ?? condition.attribute;
				const index = usableIndex(table, attribute_name);
				if (index?.customIndex?.estimateCount)
					// allow custom index to define its own estimation of counts
					condition.estimated_count = index.customIndex.estimateCount(condition.value);
				else
					condition.estimated_count =
						estimateRangeCondition(table, condition, searchType, OPEN_RANGE_ESTIMATE) ??
						OPEN_RANGE_ESTIMATE * estimatedEntryCount(table.primaryStore) + 1;
			}
			// we give a condition significantly more weight/preference if we will be ordering by it
			if (typeof condition.descending === 'boolean') condition.estimated_count /= 2;
		}
		return condition.estimated_count; // use cached count
	}
	return estimateConditionForTable;
}
class SyntaxViolation extends Violation {
	statusCode = 400;
}
const NEEDS_PARSER = /[()[\]|!<>.]|(=\w*=)/;
const QUERY_PARSER = /([^?&|=<>!([{}\]),]*)([([{}\])|,&]|[=<>!]*)/g;
const VALUE_PARSER = /([^&|=[\]{}]*)([[\]{}]|[&|]=?|=|)/g;
// Inside a `(...)` group a value may hold one level of balanced parentheses (the `(v1,v2)` list syntax), and an
// unmatched `)` closes the group
const PAREN_VALUE_PARSER = /((?:[^&|=()[\]{}]|\([^&|=()[\]{}]*\))*)([()[\]{}]|[&|]=?|=|)/g;
const FIQL_OPERATOR_NAME = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
let lastIndex;
let currentQuery;
let queryString;
/**
 * This is responsible for taking a query string (from a get()) and merging the parsed elements into a RequestTarget object.
 * @param queryString
 */
export function parseQuery(queryToParse: string, query: RequestTarget) {
	if (!queryToParse) return;
	queryString = queryToParse;
	// TODO: We can remove this if we are sure all exits points end with lastIndex as zero (reaching the end of parsing will do that)
	QUERY_PARSER.lastIndex = 0;
	if (NEEDS_PARSER.test(queryToParse)) {
		try {
			if (query) query.conditions = [];
			currentQuery = query ?? new Query();
			parseBlock(currentQuery, '');
			if (lastIndex !== queryString.length) recordError(`Unable to parse query, unexpected end of query`);
			if ((currentQuery as any).parseErrorMessage) {
				(currentQuery as any).parseError = new SyntaxViolation((currentQuery as any).parseErrorMessage);
			}
		} catch (error) {
			error.statusCode = 400;
			error.message = `Unable to parse query, ${error.message} at position ${lastIndex} in '${queryString}'`;
			if ((currentQuery as any).parseErrorMessage) error.message += ', ' + (currentQuery as any).parseErrorMessage;
			if (query) {
				query.parseError = error;
			} else {
				throw error;
			}
		}
		if (!query && (currentQuery as any).parseError) throw (currentQuery as any).parseError;
		return currentQuery;
	} else {
		return query ?? new URLSearchParams(queryToParse);
	}
}
function recordError(message: string) {
	const errorMessage = `${message} at position ${lastIndex}`;
	currentQuery.parseErrorMessage = currentQuery.parseErrorMessage
		? currentQuery.parseErrorMessage + ', ' + errorMessage
		: errorMessage;
}
function parseBlock(query, expectedEnd) {
	let parser = QUERY_PARSER;
	let match;
	let attribute, comparator, expectingDelimiter, expectingValue;
	let comparatorChosen = false;
	let valueDecoder: any = decodeURIComponent;
	let lastBinaryOperator;
	while ((match = parser.exec(queryString))) {
		lastIndex = parser.lastIndex;
		if (match[0] === '' && lastIndex < queryString.length) {
			recordError(`unexpected character '${queryString[lastIndex]}'`);
			lastIndex = queryString.length;
			return query;
		}
		const [, value, operator] = match;
		if (expectingDelimiter) {
			if (value) recordError(`expected operator, but encountered '${value}'`);
			expectingDelimiter = false;
			expectingValue = false;
		} else expectingValue = true;
		if (attribute != null && (operator === '(' || operator === '[' || operator === '{')) {
			recordError(`unexpected '${operator}' in a value`);
			lastIndex = queryString.length;
			return query;
		}
		let entry;
		switch (operator) {
			case '=':
				if (attribute != undefined) {
					// FIQL operator like =gt= or =starts_with= — accept any identifier
					// (letters, digits, underscores). Unknown comparator names are
					// caught at execution time with a clearer error.
					if (comparatorChosen) recordError(`unexpected FIQL operator ${value} after comparator ${comparator}`);
					else if (FIQL_OPERATOR_NAME.test(value)) comparator = value;
					else recordError(`invalid FIQL operator ${value}`);
					comparatorChosen = true;
					valueDecoder = fullTextComparatorMode(resolveComparator(comparator).comparator)
						? decodeURIComponent
						: typedDecoding;
				} else {
					// standard equal comparison
					valueDecoder = decodeURIComponent; // use strict decoding
					comparator = 'equals'; // strict equals
					comparatorChosen = false;
					if (!query.conditions) recordError('conditions/comparisons are not allowed in a property list');
					if (!value) recordError(`attribute must be specified before equality comparator`);
					attribute = decodeProperty(value);
				}
				break;
			case '==':
			// TODO: Separate decoder to handle * operator here for startsWith, endsWith, and contains?
			// fall through
			case '!=':
			case '<':
			case '<=':
			case '>':
			case '>=':
			case '===':
			case '!==':
				comparator = SYMBOL_OPERATORS[operator];
				comparatorChosen = true;
				if (!query.conditions) recordError('conditions/comparisons are not allowed in a property list');
				valueDecoder = COERCIBLE_OPERATORS[comparator] ? typedDecoding : decodeURIComponent;
				if (!value) recordError(`attribute must be specified before comparator ${operator}`);
				attribute = decodeProperty(value);
				break;
			case '&=': // for chaining conditions on to the same attribute
			case '|=':
			case '|':
			case '&':
			case '':
			case undefined:
				if (attribute == null) {
					if (attribute === undefined) {
						if (expectedEnd && operator) recordError(`expected '${expectedEnd}', but encountered '${operator[0]}'`);
						recordError(`no comparison specified before ${operator ? "'" + operator + "'" : 'end of string'}`);
					}
				} else addCondition(query, attribute, comparator, comparatorChosen, value, valueDecoder, lastBinaryOperator);
				if (operator === '&') {
					lastBinaryOperator = 'and';
					attribute = undefined;
				} else if (operator === '|') {
					lastBinaryOperator = 'or';
					attribute = undefined;
				} else if (operator === '&=') {
					lastBinaryOperator = 'and';
					attribute = '';
					comparatorChosen = false;
				} else if (operator === '|=') {
					lastBinaryOperator = 'or';
					attribute = '';
					comparatorChosen = false;
				}
				break;
			case ',':
				if (query.conditions) {
					// TODO: Add support for a list of values
					recordError('conditions/comparisons are not allowed in a property list');
				} else {
					query.push(decodeProperty(value));
				}
				attribute = undefined;
				break;
			case '(':
				QUERY_PARSER.lastIndex = lastIndex;
				const args = parseBlock(value ? [] : new Query(), ')');
				switch (value) {
					case '': // nested/grouped condition
						assignOperator(query, lastBinaryOperator);
						query.conditions.push(args);
						break;
					case 'limit':
						switch (args.length) {
							case 1:
								query.limit = args[0] === '' ? NaN : +args[0];
								if (!Number.isInteger(query.limit) || query.limit < 0) {
									recordError('limit must be a non-negative integer');
								}
								break;
							case 2:
								query.offset = args[0] === '' ? NaN : +args[0];
								query.limit = (args[1] === '' ? NaN : +args[1]) - query.offset;
								if (
									!Number.isInteger(query.offset) ||
									query.offset < 0 ||
									!Number.isInteger(query.limit) ||
									query.limit < 0
								) {
									recordError('limit and offset must be non-negative integers');
								}
								break;
							default:
								recordError('limit must have 1 or 2 arguments');
						}
						break;
					case 'select':
						if (Array.isArray(args[0]) && args.length === 1 && !(args[0] as any).name) {
							query.select = args[0];
							query.select.asArray = true;
						} else if (args.length === 1 && !(args[0] as any).name) query.select = args[0];
						else if (args.length === 2 && args[1] === '') query.select = args.slice(0, 1);
						else query.select = args;
						break;
					case 'group-by':
						recordError('group by is not implemented yet');
						break;
					case 'sort':
						query.sort = toSortObject(args);
						break;
					default:
						recordError(`unknown query function call ${value}`);
				}
				if (queryString[lastIndex] === ',') {
					parser.lastIndex = ++lastIndex;
				} else expectingDelimiter = true;
				attribute = null;
				break;
			case '{':
				if (query.conditions) {
					recordError('property sets are not allowed in a query');
					lastIndex = queryString.length;
					return query;
				}
				if (!value) recordError('property sets must have a defined parent property name');
				// this is interpreted as property{subProperty}
				QUERY_PARSER.lastIndex = lastIndex;
				entry = parseBlock([], '}');
				entry.name = value;
				query.push(entry);
				if (queryString[lastIndex] === ',') {
					parser.lastIndex = ++lastIndex;
				} else expectingDelimiter = true;
				break;
			case '[':
				QUERY_PARSER.lastIndex = lastIndex;
				if (value) {
					// this is interpreted as propertyWithArray[name=value&anotherOtherConditions...]
					entry = parseBlock(new Query(), ']');
					entry.name = value;
				} else {
					// this is interpreted a property list that can be used within other lists
					entry = parseBlock(query.conditions ? new Query() : [], ']');
				}
				if (query.conditions) {
					assignOperator(query, lastBinaryOperator);
					if (queryString[lastIndex] === '=') {
						// handle the case of a query parameter like property[]=value, using the standard equal behavior
						valueDecoder = decodeURIComponent; // use strict decoding
						comparator = 'equals'; // strict equals
						comparatorChosen = false;
						attribute = decodeProperty(value);
						parser.lastIndex = ++lastIndex;
						break;
					} else {
						query.conditions.push(entry);
						attribute = null;
					}
				} else {
					query.push(entry);
				}
				if (queryString[lastIndex] === ',') {
					parser.lastIndex = ++lastIndex;
				} else expectingDelimiter = true;
				break;
			case ')':
			case ']':
			case '}':
				if (expectedEnd === operator[0]) {
					// assert that it is expected
					if (query.conditions) {
						// finish condition
						if (attribute != null) {
							addCondition(
								query,
								attribute,
								comparator || 'equals',
								comparatorChosen,
								value,
								valueDecoder,
								lastBinaryOperator
							);
						} else if (value) {
							recordError('no attribute or comparison specified');
						}
					} else if (value || (query.length > 0 && expectingValue)) {
						query.push(decodeProperty(value));
					}
					return query;
				} else if (expectedEnd) recordError(`expected '${expectedEnd}', but encountered '${operator[0]}'`);
				else recordError(`unexpected token '${operator[0]}'`);
			default:
				recordError(`unexpected operator '${operator}'`);
		}
		parser = attribute == null ? QUERY_PARSER : expectedEnd === ')' ? PAREN_VALUE_PARSER : VALUE_PARSER;
		parser.lastIndex = lastIndex;
		if (lastIndex === queryString.length) {
			// a condition still pending at the end of the string is finished by one more (empty) token
			if (attribute != null && operator) continue;
			if (expectedEnd) recordError(`expected '${expectedEnd}', but encountered end of string`);
			return query;
		}
	}
	if (expectedEnd) recordError(`expected '${expectedEnd}', but encountered end of string`);
}
function addCondition(query, attribute, comparator, comparatorChosen, value, valueDecoder, lastBinaryOperator) {
	if (!query.conditions) return recordError('conditions/comparisons are not allowed in a property list');
	if (attribute === '' && !comparatorChosen) return recordError('a chained condition needs a FIQL comparator');
	const condition = buildCondition(attribute, comparator, value, valueDecoder);
	if (attribute === '') {
		const lastCondition = query.conditions[query.conditions.length - 1];
		if (lastCondition?.attribute == null) return recordError('a chained condition must follow a comparison');
		lastCondition.chainedConditions = lastCondition.chainedConditions || [];
		lastCondition.chainedConditions.push(condition);
		lastCondition.operator = lastBinaryOperator;
	} else {
		assignOperator(query, lastBinaryOperator);
		query.conditions.push(condition);
	}
}
function assignOperator(query, lastBinaryOperator) {
	if (query.conditions.length > 0) {
		if (query.operator) {
			if (query.operator !== lastBinaryOperator) recordError('Can not mix operators within a condition grouping');
		} else query.operator = lastBinaryOperator;
	}
}
function decodeProperty(name) {
	if (name.indexOf('.') > -1) {
		return name.split('.').map(decodeProperty);
	}
	return decodeURIComponent(name);
}

function typedDecoding(value) {
	// for non-strict operators, we allow for coercion of types
	if (value === 'null') return null;
	if (value.indexOf(':') > -1) {
		const [type, valueToCoerce] = value.split(':');
		if (type === 'number') {
			if (valueToCoerce[0] === '$') return parseInt(valueToCoerce.slice(1), 36);
			return +valueToCoerce;
		} else if (type === 'boolean') return valueToCoerce === 'true';
		else if (type === 'date')
			return new Date(isNaN(valueToCoerce) ? decodeURIComponent(valueToCoerce) : +valueToCoerce);
		else if (type === 'string') return decodeURIComponent(valueToCoerce);
		else throw new ClientError(`Unknown type ${type}`);
	}
	return decodeURIComponent(value);
}
/**
 * Perform wildcard detection and conversion to correct comparator
 * @param condition
 * @param value
 */
function wildcardDecoding(condition, value) {
	if (value.indexOf('*') > -1) {
		if (value.endsWith('*')) {
			condition.comparator = 'starts_with';
			condition.value = decodeURIComponent(value.slice(0, -1));
		} else {
			throw new ClientError('wildcard can only be used at the end of a string');
		}
	}
}

/**
 * Build a condition from a parsed attribute, raw comparator name, raw value
 * string, and the value decoder for the operator. Centralizes:
 *  - alias resolution and `not_` prefix handling (for `negated`)
 *  - `(v1,v2,...)` list-value syntax for list-taking comparators
 *  - wildcard detection on `eq` (typed-equality)
 */
function buildCondition(
	attribute: any,
	rawComparator: string | undefined,
	rawValue: string,
	valueDecoder: (s: string) => any
) {
	const { comparator: resolvedComparator, negated } = resolveComparator(rawComparator);
	let value: any;
	if (
		LIST_VALUE_COMPARATORS.has(ALTERNATE_COMPARATOR_NAMES[resolvedComparator] ?? resolvedComparator) &&
		rawValue.length >= 2 &&
		rawValue.charCodeAt(0) === 0x28 /* ( */ &&
		rawValue.charCodeAt(rawValue.length - 1) === 0x29 /* ) */
	) {
		// `(v1,v2,...)` list-value syntax. Each element is decoded individually.
		const inner = rawValue.slice(1, -1);
		value = inner.length === 0 ? [] : inner.split(',').map(valueDecoder);
	} else {
		value = valueDecoder(rawValue);
	}
	const condition: any = {
		comparator: resolvedComparator,
		attribute: attribute || null,
		value,
	};
	if (negated) condition.negated = true;
	// preserve existing wildcard behavior on coercive equality
	if (rawComparator === 'eq') wildcardDecoding(condition, rawValue);
	return condition;
}

function toSortObject(sort) {
	const sortObject = toSortEntry(sort[0]);
	if (sort.length > 1) {
		sortObject.next = toSortObject(sort.slice(1));
	}
	return sortObject;
}
function toSortEntry(sort) {
	if (Array.isArray(sort)) {
		const sortObject = toSortEntry(sort[0]);
		sort[0] = sortObject.attribute;
		sortObject.attribute = sort;
		return sortObject;
	}
	if (typeof sort === 'string') {
		switch (sort[0]) {
			case '-':
				return { attribute: sort.slice(1), descending: true };
			case '+':
				return { attribute: sort.slice(1), descending: false };
			default:
				return { attribute: sort, descending: false };
		}
	}
	recordError(`Unknown sort type ${sort}`);
}

class Query {
	declare conditions: { attribute: string; value: any; comparator: string }[];
	declare limit: number;
	declare offset: number;
	declare select: string[];
	constructor() {
		this.conditions = [];
	}
	[Symbol.iterator]() {
		return this.conditions[Symbol.iterator]();
	}
	get(name) {
		for (let i = 0; i < this.conditions.length; i++) {
			const condition = this.conditions[i];
			if (condition.attribute === name) return condition.value;
		}
	}
	getAll() {
		const values = [];
		for (let i = 0, len = this.conditions.length; i < len; i++) {
			const condition = this.conditions[i];
			if (condition.attribute) values.push(condition.value);
		}
		return values;
	}
}
export function flattenKey(key) {
	if (Array.isArray(key)) return key.join('\x00');
	return key;
}

export function estimatedEntryCount(store) {
	const now = Date.now();
	if ((store.estimatedEntryCountExpires || 0) < now) {
		// getStats is the LMDB fast path; for RocksDB, estimate-num-keys is O(1) where an exact
		// getKeysCount() would iterate the entire store
		store.estimatedEntryCount =
			store instanceof RocksDatabase ? store.getEstimatedKeyCount() : store.getStats().entryCount;
		store.estimatedEntryCountExpires = now + 10000;
	}
	return store.estimatedEntryCount;
}

export function intersectionEstimate(store, left, right) {
	return (left * right) / Math.max(estimatedEntryCount(store), 1);
}
