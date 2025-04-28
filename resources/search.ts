import { ClientError, ServerError } from '../utility/errors/hdbError.js';
import { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH, SEARCH_TYPES } from '../utility/lmdb/terms.js';
import { compareKeys, MAXIMUM_KEY } from 'ordered-binary';
import { SKIP } from 'lmdb';
import { INVALIDATED, EVICTED } from './Table.ts';
import type { DirectCondition, Id } from './ResourceInterface.ts';
import { MultiPartId } from './Resource.ts';
// these are ratios/percentages of overall table size
const OPEN_RANGE_ESTIMATE = 0.3;
const BETWEEN_ESTIMATE = 0.1;
const STARTS_WITH_ESTIMATE = 0.05;

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
export function executeConditions(conditions, operator, table, txn, request, context, transformToEntries, filtered) {
	const firstSearch = conditions[0];
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
		const returnedIds = new Set();
		return results.filter((entry) => {
			const id = entry.key ?? entry;
			if (returnedIds.has(id))
				// skip duplicate ids
				return false;
			returnedIds.add(id);
			return true;
		});
	} else {
		// AND
		const results = executeCondition(firstSearch);
		// get the intersection of condition searches by using the indexed query for the first condition
		// and then filtering by all subsequent conditions.
		// now apply filters that require looking up records
		const filters = mapConditionsToFilters(conditions.slice(1), true, firstSearch.estimated_count);
		return filters.length > 0 ? transformToEntries(results, filters) : results;
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
				filtered
			);
		return searchByIndex(
			condition,
			txn,
			condition.descending || request.reverse === true,
			table,
			request.allowFullScan,
			filtered
		);
	}
	function mapConditionsToFilters(conditions, intersection, estimatedIncomingCount) {
		return conditions
			.map((condition, index) => {
				if (condition.conditions) {
					// this is a group of conditions, we need to combine them
					const union = condition.operator === 'or';
					const filters = mapConditionsToFilters(condition.conditions, !union, estimatedIncomingCount);
					if (union) return (record, entry) => filters.some((filter) => filter(record, entry));
					else return (record, entry) => filters.every((filter) => filter(record, entry));
				}
				const isPrimaryKey = (condition.attribute || condition[0]) === table.primaryKey;
				const filter = filterByType(condition, table, context, filtered, isPrimaryKey, estimatedIncomingCount);
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
 * Search for records or keys, based on the search condition, using an index if available
 * @param searchCondition
 * @param transaction
 * @param reverse
 * @param Table
 * @param allowFullScan
 * @param filtered
 */
export function searchByIndex(
	searchCondition: DirectCondition,
	transaction: any,
	reverse: boolean,
	Table: any,
	allowFullScan?: boolean,
	filtered?: boolean
): AsyncIterable<Id | { key: Id; value: any }> {
	let attribute_name = searchCondition[0] ?? searchCondition.attribute;
	let value = searchCondition[1] ?? searchCondition.value;
	const comparator = searchCondition.comparator;
	if (value === undefined && comparator !== 'sort') {
		throw new ClientError(`Search condition for ${attribute_name} must have a value`);
	}
	if (Array.isArray(attribute_name)) {
		const firstAttributeName = attribute_name[0];
		// get the potential relationship attribute
		const attribute = findAttribute(Table.attributes, firstAttributeName);
		if (attribute.relationship) {
			// it is a join/relational query
			if (attribute_name.length < 2)
				throw new ClientError(
					'Can not directly query a relational attribute, must query an attribute within the target table'
				);
			const relatedTable = attribute.definition?.tableClass || attribute.elements?.definition?.tableClass;
			const joined = new Map();
			// search the related table
			let results = searchByIndex(
				{
					attribute: attribute_name.length > 2 ? attribute_name.slice(1) : attribute_name[1],
					value,
					comparator,
				},
				transaction,
				reverse,
				relatedTable,
				allowFullScan,
				joined
			);
			if (attribute.relationship.to) {
				// this is one-to-many or many-to-many, so we need to track the filtering of related entries that match
				filtered[attribute_name[0]] = joined;
				// Use the joinTo to join the results of the related table to the current table (can be one-to-many or many-to-many)
				const isManyToMany = Boolean(findAttribute(relatedTable.attributes, attribute.relationship.to)?.elements);
				results = joinTo(results, attribute, relatedTable.primaryStore, isManyToMany, joined);
			}
			if (attribute.relationship.from) {
				const searchEntry = (relatedEntry) => {
					if (relatedEntry?.key !== undefined) relatedEntry = relatedEntry.key;
					return searchByIndex(
						{ attribute: attribute.relationship.from, value: relatedEntry },
						transaction,
						reverse,
						Table,
						allowFullScan,
						joined
					);
				};
				if (attribute.elements) {
					filtered[attribute_name[0]] = joined;
					// many-to-many relationship (forward), get all the ids first
					results = joinFrom(results, attribute, relatedTable.primaryStore, joined, searchEntry);
				} else {
					// many-to-one relationship, need to flatten the ids that point back to potentially many instances of this
					results = results.flatMap(searchEntry);
				}
			}
			return results;
		} else if (attribute_name.length === 1) {
			attribute_name = attribute_name[0];
		} else {
			throw new ClientError('Unable to query by attribute ' + JSON.stringify(attribute_name));
		}
	}
	let start;
	let end, inclusiveEnd, exclusiveStart;
	if (value instanceof Date) value = value.getTime();
	let needFullScan;
	switch (ALTERNATE_COMPARATOR_NAMES[comparator] || comparator) {
		case 'lt':
			start = true;
			end = value;
			break;
		case 'le':
			start = true;
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
			start = value;
			end = value.slice(0);
			end[end.length - 1] = MAXIMUM_KEY;
			break;
		case 'starts_with':
			start = value.toString();
			end = value + String.fromCharCode(0xffff);
			break;
		case 'between':
		case 'gele':
		case 'gelt':
		case 'gtlt':
		case 'gtle':
			start = value[0];
			if (start instanceof Date) start = start.getTime();
			end = value[1];
			if (end instanceof Date) end = end.getTime();
			inclusiveEnd = comparator === 'gele' || comparator === 'gtle' || comparator === 'between';
			exclusiveStart = comparator === 'gtlt' || comparator === 'gtle';
			break;
		case 'equals':
		case undefined:
			start = value;
			end = value;
			inclusiveEnd = true;
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
			start = true;
			needFullScan = true;
			break;
		default:
			throw new ClientError(`Unknown query comparator "${comparator}"`);
	}
	let filter;
	const isPrimaryKey = attribute_name === Table.primaryKey || attribute_name == null;
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
	if (reverse) {
		let newEnd = start;
		start = end;
		end = newEnd;
		newEnd = !exclusiveStart;
		exclusiveStart = !inclusiveEnd;
		inclusiveEnd = newEnd;
	}
	const index = isPrimaryKey ? Table.primaryStore : Table.indices[attribute_name];
	if (!index || index.isIndexing || needFullScan || (value === null && !index.indexNulls)) {
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
			throw new ServerError(`"${attribute_name}" is not indexed yet, can not search for this attribute`, 503);
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
		const results = index.getRange(rangeOptions).map(
			filter
				? function ({ key, value }) {
						if (this?.isSync) return value && filter(value) ? key : SKIP;
						// for filter operations, we intentionally yield the event turn so that scanning queries
						// do not hog resources
						return new Promise((resolve, reject) =>
							setImmediate(() => {
								try {
									resolve(value && filter(value) ? key : SKIP);
								} catch (error) {
									reject(error);
								}
							})
						);
					}
				: (entry) => {
						if (entry.value == null && !(entry.metadataFlags & (INVALIDATED | EVICTED))) return SKIP;
						return entry;
					}
		);
		results.hasEntries = true;
		return results;
	} else if (index) {
		return index.getRange(rangeOptions).map(
			filter
				? function ({ key, value }) {
						let recordMatcher: any;
						if (typeof key === 'string' && key.length > MAX_SEARCH_KEY_LENGTH) {
							// if it is an overflow string, need to get the actual value from the database
							recordMatcher = Table.primaryStore.get(value);
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
	} else {
		return Table.primaryStore
			.getRange(reverse ? { end: true, transaction, reverse: true } : { start: true, transaction })
			.map(function ({ key, value }) {
				if (this.isSync) return value && filter(value) ? key : SKIP;
				// for filter operations, we intentionally yield the event turn so that scanning queries
				// do not hog resources
				return new Promise((resolve, reject) =>
					setImmediate(() => {
						try {
							resolve(value && filter(value) ? key : SKIP);
						} catch (error) {
							reject(error);
						}
					})
				);
			});
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
 * @returns
 */
function joinTo(rightIterable, attribute, store, isManyToMany, joined: Map<any, any[]>) {
	return new rightIterable.constructor({
		[Symbol.iterator]() {
			let joinedIterator;
			joined.hasMappings = true;
			return {
				next() {
					if (!joinedIterator) {
						const rightProperty = attribute.relationship.to;
						const addEntry = (key, entry) => {
							let entriesForKey = joined.get(key);
							if (entriesForKey) entriesForKey.push(entry);
							else joined.set(key, (entriesForKey = [entry]));
						};
						//let i = 0;
						// get all the ids of the related records
						for (const entry of rightIterable) {
							const record = entry.value ?? store.get(entry.key ?? entry);
							const leftKey = record?.[rightProperty];
							if (leftKey == null) continue;
							if (joined.filters?.some((filter) => !filter(record))) continue;
							if (isManyToMany) {
								for (let i = 0; i < leftKey.length; i++) {
									addEntry(leftKey[i], entry);
								}
							} else {
								addEntry(leftKey, entry);
							}
							// TODO: Enable this with async iterator manually iterating so that we don't need to do an await on every iteration
							/*
							if (i++ > 100) {
								// yield the event turn every 100 ids. See below for more explanation
								await new Promise(setImmediate);
								i = 0;
							}*/
						}
						joinedIterator = joined.keys()[Symbol.iterator]();
						return this.next();
					}
					const joinedEntry = joinedIterator.next();
					if (joinedEntry.done) return joinedEntry;
					return {
						// if necessary, get the original key from the entries array
						value: joinedEntry.value,
					};
				},
				return() {
					if (joinedIterator?.return) return joinedIterator.return();
				},
			};
		},
	});
}
/**
 * This is used to join the results of a query where the right side is a set of ids and the left side is a set of records
 * that have the foreign key (from left to right)
 * @param rightIterable
 * @param attribute
 * @param store
 * @param joined
 * @param searchEntry
 * @returns
 */
function joinFrom(rightIterable, attribute, store, joined: Map<any, any[]>, searchEntry) {
	return new rightIterable.constructor({
		[Symbol.iterator]() {
			let idIterator;
			let joinedIterator;
			const seenIds = new Set();
			return {
				next() {
					let joinedEntry;
					if (joinedIterator) {
						while (true) {
							joinedEntry = joinedIterator.next();
							if (joinedEntry.done) break; // and continue to find next
							const id = joinedEntry.value;
							if (seenIds.has(id)) continue;
							seenIds.add(id);
							return joinedEntry;
						}
					}
					if (!idIterator) {
						// get the ids of the related records as a Set so we can quickly check if it is in the set
						// when are iterating through the results
						const ids = new Set();
						// Define the fromRecord function so that we can use it to filter the related records
						// that are in the select(), to only those that are in this set of ids
						joined.fromRecord = (record) => {
							// TODO: Sort based on order ids
							return record[attribute.relationship.from]?.filter?.((id) => ids.has(id));
						};
						//let i = 0;
						// get all the ids of the related records
						for (const id of rightIterable) {
							if (joined.filters) {
								// if additional filters are defined, we need to check them
								const record = store.get(id);
								if (joined.filters.some((filter) => !filter(record))) continue;
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
						return this.next();
					}
					do {
						const idEntry = idIterator.next();
						if (idEntry.done) return idEntry;
						joinedIterator = searchEntry(idEntry.value)[Symbol.iterator]();
						return this.next();
					} while (true);
				},
				return() {
					return joinedIterator?.return?.();
				},
				throw() {
					return joinedIterator?.throw?.();
				},
			};
		},
	});
}

const ALTERNATE_COMPARATOR_NAMES = {
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
	'>': 'gt',
	'>=': 'ge',
	'<': 'lt',
	'<=': 'le',
	'...': 'between',
};

/**
 * Create a filter based on the search condition that can be used to test each supplied record.
 * @param {SearchObject} searchCondition
 * @returns {({}) => boolean}
 */
export function filterByType(searchCondition, Table, context, filtered, isPrimaryKey?, estimatedIncomingCount?) {
	const comparator = searchCondition.comparator;
	let attribute = searchCondition[0] ?? searchCondition.attribute;
	let value = searchCondition[1] ?? searchCondition.value;
	if (Array.isArray(attribute)) {
		if (attribute.length === 0) return () => true;
		if (attribute.length === 1) attribute = attribute[0];
		else if (attribute.length > 1) {
			const firstAttributeName = attribute[0];
			// get the relationship attribute
			const firstAttribute = findAttribute(Table.attributes, firstAttributeName);
			const relatedTable = firstAttribute.definition?.tableClass || firstAttribute.elements.definition?.tableClass;
			// TODO: If this is a relationship, we can potentially make this more efficient by using the index
			// and retrieving the set of matching ids first
			const filterMap = filtered?.[firstAttributeName];
			const nextFilter = filterByType(
				{
					attribute: attribute.length > 2 ? attribute.slice(1) : attribute[1],
					value,
					comparator,
				},
				relatedTable,
				context,
				filterMap?.[firstAttributeName]?.joined,
				attribute[1] === relatedTable.primaryKey,
				estimatedIncomingCount
			);
			if (!nextFilter) return;
			if (filterMap) {
				if (!filterMap.filters) filterMap.filters = [];
				filterMap.filters.push(nextFilter);
				return;
			}
			const resolver = Table.propertyResolvers?.[firstAttributeName];
			let subIdFilter;
			const recordFilter = (record, entry) => {
				let subObject, subEntry;
				if (resolver) {
					if (resolver.from && nextFilter.idFilter) {
						// if we are filtering by id, we can use the idFilter to avoid loading the record
						if (!subIdFilter) {
							if (nextFilter.idFilter.idSet?.size === 1) {
								// if there is a single id we are looking for, we can create a new search condition that the
								// attribute comparator could eventually use to create a recursive id set
								// TODO: Eventually we should be able to handle multiple ids by creating a union
								for (const id of nextFilter.idFilter.idSet) {
									searchCondition = {
										attribute: resolver.from,
										value: id,
									};
								}
								// indicate that we can use an index for this. also we indicate that we allow object matching to allow array ids to directly tested
								subIdFilter = attributeComparator(resolver.from, nextFilter.idFilter, true, true);
							} else subIdFilter = attributeComparator(resolver.from, nextFilter.idFilter, false, true);
						}
						const matches = subIdFilter(record);
						if (subIdFilter.idFilter) recordFilter.idFilter = subIdFilter.idFilter;
						return matches;
					}
					subEntry = resolver(record, context, entry);
					subObject = subEntry?.value;
				} else subObject = record[firstAttributeName];
				if (!subObject) return false;
				if (!Array.isArray(subObject)) return nextFilter(subObject, subEntry);
				return subObject.some(nextFilter);
			};
			return recordFilter;
		}
	}
	if (value instanceof Date) value = value.getTime();

	switch (ALTERNATE_COMPARATOR_NAMES[comparator] || comparator) {
		case SEARCH_TYPES.EQUALS:
		case undefined:
			return attributeComparator(attribute, (recordValue) => recordValue === value, true);
		case 'contains':
			return attributeComparator(attribute, (recordValue) => recordValue?.toString().includes(value));
		case 'ends_with':
			return attributeComparator(attribute, (recordValue) => recordValue?.toString().endsWith(value));
		case 'starts_with':
			return attributeComparator(
				attribute,
				(recordValue) => typeof recordValue === 'string' && recordValue.startsWith(value),
				true
			);
		case 'prefix':
			if (!Array.isArray(value)) value = [value];
			else if (value[value.length - 1] == null) value = value.slice(0, -1);
			return attributeComparator(
				attribute,
				(recordValue) => {
					if (!Array.isArray(recordValue)) return false;
					for (let i = 0, l = value.length; i < l; i++) {
						if (recordValue[i] !== value[i]) return false;
					}
					return true;
				},
				true
			);
		case 'between':
			if (value[0] instanceof Date) value[0] = value[0].getTime();
			if (value[1] instanceof Date) value[1] = value[1].getTime();
			return attributeComparator(
				attribute,
				(recordValue) => {
					return compareKeys(recordValue, value[0]) >= 0 && compareKeys(recordValue, value[1]) <= 0;
				},
				true
			);
		case 'gt':
			return attributeComparator(attribute, (recordValue) => compareKeys(recordValue, value) > 0);
		case 'ge':
			return attributeComparator(attribute, (recordValue) => compareKeys(recordValue, value) >= 0);
		case 'lt':
			return attributeComparator(attribute, (recordValue) => compareKeys(recordValue, value) < 0);
		case 'le':
			return attributeComparator(attribute, (recordValue) => compareKeys(recordValue, value) <= 0);
		case 'ne':
			return attributeComparator(attribute, (recordValue) => compareKeys(recordValue, value) !== 0, false, true);
		case 'sort':
			return () => true;
		default:
			throw new ClientError(`Unknown query comparator "${comparator}"`);
	}
	/** Create a comparison function that can take the record and check the attribute's value with the filter function */
	function attributeComparator(
		attribute: string,
		filter: (record: any) => boolean,
		canUseIndex?: boolean,
		allowObjectMatching?: boolean
	) {
		let thresholdRemainingMisses: number;
		canUseIndex =
			canUseIndex && // is it a comparator that makes sense to use index
			!isPrimaryKey && // no need to use index for primary keys, since we will be iterating over the primary keys
			Table?.indices[attribute] && // is there an index for this attribute
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
			const value = record[attribute];
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
					(++misses / filteredSoFar) * (estimatedIncomingCount - filteredSoFar) > thresholdRemainingMisses
				) {
					// if we have missed too many times, we need to switch to indexed retrieval
					const matchingIds = searchByIndex(searchCondition, context.transaction.getReadTxn(), false, Table).map(
						flattenKey
					);
					// now generate a hash set that we can efficiently check primary keys against
					// TODO: Do this asynchronously
					const idSet = new Set(matchingIds);
					recordFilter.idFilter = (id) => idSet.has(flattenKey(id));
					recordFilter.idFilter.idSet = idSet;
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
							? (estimatedCount * subCondition.estimated_count) / estimatedEntryCount(table.primaryStore)
							: subCondition.estimated_count;
					}
				}
				condition.estimated_count = estimatedCount;
				return condition.estimated_count;
			}
			// skip if it is cached
			let searchType = condition.comparator || condition.search_type;
			searchType = ALTERNATE_COMPARATOR_NAMES[searchType] || searchType;
			if (searchType === SEARCH_TYPES.EQUALS || !searchType) {
				const attribute_name = condition[0] ?? condition.attribute;
				if (attribute_name == null || attribute_name === table.primaryKey) condition.estimated_count = 1;
				else if (Array.isArray(attribute_name) && attribute_name.length > 1) {
					const attribute = findAttribute(table.attributes, attribute_name[0]);
					const relatedTable = attribute.definition?.tableClass || attribute.elements.definition?.tableClass;
					const estimate = estimateCondition(relatedTable)({
						value: condition.value,
						attribute: attribute_name.length > 2 ? attribute_name.slice(1) : attribute_name[1],
						comparator: 'equals',
					});
					const fromIndex = table.indices[attribute.relationship.from];
					// the estimated count is sum of the estimate of the related table and the estimate of the index
					condition.estimated_count =
						estimate +
						(fromIndex
							? (estimate * estimatedEntryCount(table.indices[attribute.relationship.from])) /
								(estimatedEntryCount(relatedTable.primaryStore) || 1)
							: estimate);
				} else {
					// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
					const index = table.indices[attribute_name];
					condition.estimated_count = index ? index.getValuesCount(condition[1] ?? condition.value) : Infinity;
				}
			} else if (searchType === 'contains' || searchType === 'ends_with' || searchType === 'ne') {
				const attribute_name = condition[0] ?? condition.attribute;
				const index = table.indices[attribute_name];
				if (condition.value === null && searchType === 'ne') {
					condition.estimated_count =
						estimatedEntryCount(table.primaryStore) - (index ? index.getValuesCount(null) : 0);
				} else condition.estimated_count = Infinity;
				// for range queries (betweens, startsWith, greater, etc.), just arbitrarily guess
			} else if (searchType === 'starts_with' || searchType === 'prefix')
				condition.estimated_count = STARTS_WITH_ESTIMATE * estimatedEntryCount(table.primaryStore) + 1;
			else if (searchType === 'between')
				condition.estimated_count = BETWEEN_ESTIMATE * estimatedEntryCount(table.primaryStore) + 1;
			else if (searchType === 'sort')
				condition.estimated_count = estimatedEntryCount(table.primaryStore) + 1; // only used by sort
			// for the search types that use the broadest range, try do them last
			else condition.estimated_count = OPEN_RANGE_ESTIMATE * estimatedEntryCount(table.primaryStore) + 1;
			// we give a condition significantly more weight/preference if we will be ordering by it
			if (typeof condition.descending === 'boolean') condition.estimated_count /= 2;
		}
		return condition.estimated_count; // use cached count
	}
	return estimateConditionForTable;
}
const NEEDS_PARSER = /[()[\]|!<>.]|(=\w*=)/;
const QUERY_PARSER = /([^?&|=<>!([{}\]),]*)([([{}\])|,&]|[=<>!]*)/g;
const VALUE_PARSER = /([^&|=[\]{}]+)([[\]{}]|[&|=]*)/g;
let lastIndex;
let queryString;
/**
 * This is responsible for taking a query string (from a get()) and converting it to a standard query object
 * structure
 * @param queryString
 */
export function parseQuery(queryToParse) {
	if (!queryToParse) return;
	queryString = queryToParse;
	// TODO: We can remove this if we are sure all exits points end with lastIndex as zero (reaching the end of parsing will do that)
	QUERY_PARSER.lastIndex = 0;
	if (NEEDS_PARSER.test(queryToParse)) {
		try {
			const query = parseBlock(new Query(), '');
			if (lastIndex !== queryString.length) throw new SyntaxError(`Unable to parse query, unexpected end of query`);
			return query;
		} catch (error) {
			error.statusCode = 400;
			error.message = `Unable to parse query, ${error.message} at position ${lastIndex} in '${queryString}'`;
			throw error;
		}
	} else {
		return new URLSearchParams(queryToParse);
	}
}
function parseBlock(query, expectedEnd) {
	let parser = QUERY_PARSER;
	let match;
	let attribute, comparator, expectingDelimiter, expectingValue;
	let valueDecoder = decodeURIComponent;
	let lastBinaryOperator;
	while ((match = parser.exec(queryString))) {
		lastIndex = parser.lastIndex;
		const [, value, operator] = match;
		if (expectingDelimiter) {
			if (value) throw new SyntaxError(`expected operator, but encountered '${value}'`);
			expectingDelimiter = false;
			expectingValue = false;
		} else expectingValue = true;
		let entry;
		switch (operator) {
			case '=':
				if (attribute != undefined) {
					// a FIQL operator like =gt= (and don't allow just any string)
					if (value.length <= 2) comparator = value;
					else throw new SyntaxError(`invalid FIQL operator ${value}`);
					valueDecoder = typedDecoding; // use typed/auto-cast decoding for FIQL operators
				} else {
					// standard equal comparison
					valueDecoder = decodeURIComponent; // use strict decoding
					comparator = 'equals'; // strict equals
					if (!value) throw new SyntaxError(`attribute must be specified before equality comparator`);
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
				valueDecoder = COERCIBLE_OPERATORS[comparator] ? typedDecoding : decodeURIComponent;
				if (!value) throw new SyntaxError(`attribute must be specified before comparator ${operator}`);
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
						if (expectedEnd)
							throw new SyntaxError(
								`expected '${expectedEnd}', but encountered ${operator[0] ? "'" + operator[0] + "'" : 'end of string'}}`
							);
						throw new SyntaxError(
							`no comparison specified before ${operator ? "'" + operator + "'" : 'end of string'}`
						);
					}
				} else {
					if (!query.conditions) throw new SyntaxError('conditions/comparisons are not allowed in a property list');
					const condition = {
						comparator,
						attribute: attribute || null,
						value: valueDecoder(value),
					};
					if (comparator === 'eq') wildcardDecoding(condition, value);
					if (attribute === '') {
						// this is a nested condition
						const lastCondition = query.conditions[query.conditions.length - 1];
						lastCondition.chainedConditions = lastCondition.chainedConditions || [];
						lastCondition.chainedConditions.push(condition);
						lastCondition.operator = lastBinaryOperator;
					} else {
						assignOperator(query, lastBinaryOperator);
						query.conditions.push(condition);
					}
				}
				if (operator === '&') {
					lastBinaryOperator = 'and';
					attribute = undefined;
				} else if (operator === '|') {
					lastBinaryOperator = 'or';
					attribute = undefined;
				} else if (operator === '&=') {
					lastBinaryOperator = 'and';
					attribute = '';
				} else if (operator === '|=') {
					lastBinaryOperator = 'or';
					attribute = '';
				}
				break;
			case ',':
				if (query.conditions) {
					// TODO: Add support for a list of values
					throw new SyntaxError('conditions/comparisons are not allowed in a property list');
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
								query.limit = +args[0];
								break;
							case 2:
								query.offset = +args[0];
								query.limit = args[1] - query.offset;
								break;
							default:
								throw new SyntaxError('limit must have 1 or 2 arguments');
						}
						break;
					case 'select':
						if (Array.isArray(args[0]) && args.length === 1 && !args[0].name) {
							query.select = args[0];
							query.select.asArray = true;
						} else if (args.length === 1) query.select = args[0];
						else if (args.length === 2 && args[1] === '') query.select = args.slice(0, 1);
						else query.select = args;
						break;
					case 'group-by':
						throw new SyntaxError('group by is not implemented yet');
					case 'sort':
						query.sort = toSortObject(args);
						break;
					default:
						throw new SyntaxError(`unknown query function call ${value}`);
				}
				if (queryString[lastIndex] === ',') {
					parser.lastIndex = ++lastIndex;
				} else expectingDelimiter = true;
				attribute = null;
				break;
			case '{':
				if (query.conditions) throw new SyntaxError('property sets are not allowed in a queries');
				if (!value) throw new SyntaxError('property sets must have a defined parent property name');
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
					query.conditions.push(entry);
					attribute = null;
				} else query.push(entry);
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
						if (attribute) {
							const condition = {
								comparator: comparator || 'equals',
								attribute,
								value: valueDecoder(value),
							};
							if (comparator === 'eq') wildcardDecoding(condition, value);
							assignOperator(query, lastBinaryOperator);
							query.conditions.push(condition);
						} else if (value) {
							throw new SyntaxError('no attribute or comparison specified');
						}
					} else if (value || (query.length > 0 && expectingValue)) {
						query.push(decodeProperty(value));
					}
					return query;
				} else if (expectedEnd) throw new SyntaxError(`expected '${expectedEnd}', but encountered '${operator[0]}'`);
				else throw new SyntaxError(`unexpected token '${operator[0]}'`);
			default:
				throw new SyntaxError(`unexpected operator '${operator}'`);
		}
		if (expectedEnd !== ')') {
			parser = attribute ? VALUE_PARSER : QUERY_PARSER;
			parser.lastIndex = lastIndex;
		}
		if (lastIndex === queryString.length) return query;
	}
	if (expectedEnd) throw new SyntaxError(`expected '${expectedEnd}', but encountered end of string`);
}
function assignOperator(query, lastBinaryOperator) {
	if (query.conditions.length > 0) {
		if (query.operator) {
			if (query.operator !== lastBinaryOperator)
				throw new SyntaxError('Can not mix operators within a condition grouping');
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
	throw new SyntaxError(`Unknown sort type ${sort}`);
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
		for (let i = 0; i < this.conditions.length; i++) {
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

function estimatedEntryCount(store) {
	const now = Date.now();
	if ((store.estimatedEntryCountExpires || 0) < now) {
		store.estimatedEntryCount = store.getStats().entryCount;
		store.estimatedEntryCountExpires = now + 10000;
	}
	return store.estimatedEntryCount;
}

export function intersectionEstimate(store, left, right) {
	return (left * right) / estimatedEntryCount(store);
}
export class SimpleURLQuery {
	url?: string;
	id: any;
	constructor(url?: string, id?: any) {
		this.url = url;
		this.id = id;
	}
	get pathname() {
		return this.url.split('?')[0];
	}
	get() {
		// this is a simple holder for the URL query, so we don't return anything (will be parsed later into a USP or Query object as needed)
	}
	[Symbol.iterator]() {
		return [][Symbol.iterator]();
	}
	toString() {
		return this.url ?? '/' + this.id;
	}
	getAll() {
		return [];
	}
}
