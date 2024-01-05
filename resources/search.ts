import { ClientError } from '../utility/errors/hdbError';
import * as lmdb_terms from '../utility/lmdb/terms';
import { compareKeys, MAXIMUM_KEY } from 'ordered-binary';
import { RangeIterable, SKIP } from 'lmdb';
import { join } from 'path';
// these are ratios/percentages of overall table size
const OPEN_RANGE_ESTIMATE = 0.3;
const BETWEEN_ESTIMATE = 0.1;
const STARTS_WITH_ESTIMATE = 0.05;

const SYMBOL_OPERATORS = {
	'<': 'lt',
	'<=': 'le',
	'>': 'gt',
	'>=': 'ge',
	'!=': 'ne',
};

export function searchByIndex(search_condition, transaction, reverse, Table, allow_full_scan?, filtered?) {
	let attribute_name = search_condition[0] ?? search_condition.attribute;
	let value = search_condition[1] ?? search_condition.value;
	const comparator = search_condition.comparator;
	if (Array.isArray(attribute_name)) {
		const first_attribute_name = attribute_name[0];
		// get the potential relationship attribute
		const attribute = findAttribute(Table.attributes, first_attribute_name);
		if (attribute.relationship) {
			// it is a join/relational query
			if (attribute_name.length < 2)
				throw new ClientError(
					'Can not directly query a relational attribute, must query an attribute within the target table'
				);
			const related_table = attribute.definition?.tableClass || attribute.elements?.definition?.tableClass;
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
				related_table,
				allow_full_scan,
				joined
			);
			if (attribute.relationship.to) {
				// this is one-to-many or many-to-many, so we need to track the filtering of related entries that match
				filtered[attribute_name[0]] = joined;
				// Use the joinTo to join the results of the related table to the current table (can be one-to-many or many-to-many)
				const is_many_to_many = Boolean(findAttribute(related_table.attributes, attribute.relationship.to)?.elements);
				results = joinTo(results, attribute, related_table.primaryStore, is_many_to_many, joined);
			}
			if (attribute.relationship.from) {
				const searchEntry = (related_entry) => {
					return searchByIndex(
						{ attribute: attribute.relationship.from, value: related_entry },
						transaction,
						reverse,
						Table,
						allow_full_scan,
						joined
					);
				};
				if (attribute.elements) {
					filtered[attribute_name[0]] = joined;
					// many-to-many relationship (forward), get all the ids first
					results = joinFrom(results, attribute, related_table.primaryStore, joined, searchEntry);
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
	let need_full_scan;
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
			start = value[0];
			if (start instanceof Date) start = start.getTime();
			end = value[1];
			if (end instanceof Date) end = end.getTime();
			inclusiveEnd = true;
			break;
		case lmdb_terms.SEARCH_TYPES.EQUALS:
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
		case 'contains':
		case 'ends_with':
			// we have to revert to full table scan here
			need_full_scan = true;
			break;
		default:
			throw new ClientError(`Unknown query comparator "${comparator}"`);
	}
	if (reverse) {
		let new_end = start;
		start = end;
		end = new_end;
		new_end = !exclusiveStart;
		exclusiveStart = !inclusiveEnd;
		inclusiveEnd = new_end;
	}
	const is_primary_key = attribute_name === Table.primaryKey || attribute_name == null;
	const index = is_primary_key ? Table.primaryStore : Table.indices[attribute_name];

	if (!index || index.isIndexing || need_full_scan || (value === null && !index.indexNulls)) {
		// no indexed searching available, need a full scan
		if (!allow_full_scan)
			throw new ClientError(
				`"${attribute_name}" is not indexed${
					value === null && !index.indexNulls
						? ' for nulls, index needs to be rebuilt to search for nulls'
						: index?.isIndexing
						? ' yet'
						: ''
				}, can not search for this attribute`,
				404
			);
		const filter = filterByType(search_condition);
		if (!filter) {
			throw new ClientError(`Unknown search operator ${search_condition.comparator}`);
		}
		// for filter operations, we intentionally yield the event turn so that scanning queries
		// do not hog resources
		return Table.primaryStore.getRange({ start: true, transaction, reverse }).map(
			({ key, value }) =>
				new Promise((resolve, reject) =>
					setImmediate(() => {
						try {
							resolve(value && filter(value) ? key : SKIP);
						} catch (error) {
							reject(error);
						}
					})
				)
		);
	}
	const range_options = {
		start,
		end,
		inclusiveEnd,
		exclusiveStart,
		values: true,
		versions: is_primary_key,
		transaction,
		reverse,
	};
	if (is_primary_key) {
		const results = index.getRange(range_options).map((entry) => {
			if (entry.value == null) return SKIP;
			return entry;
		});
		results.hasEntries = true;
		return results;
	} else {
		return index.getRange(range_options).map(({ value }) => value);
	}
}

export function findAttribute(attributes, attribute_name) {
	if (Array.isArray(attribute_name)) {
		if (attribute_name.length > 1) {
			const first_attribute = findAttribute(attributes, attribute_name[0]);
			const next_attributes = (
				first_attribute?.definition?.tableClass || first_attribute?.elements.definition?.tableClass
			)?.attributes;
			if (next_attributes) return findAttribute(next_attributes, attribute_name.slice(1));
			return;
		} else attribute_name = attribute_name.toString();
	} else if (typeof attribute_name !== 'string') attribute_name = attribute_name.toString();
	return attributes.find((attribute) => attribute.name === attribute_name);
}

/**
 * This is used to join the results of a query where the right side is a set of records with the foreign key that
 * points to the left side (from right to left)
 * @param right_iterable
 * @param attribute
 * @param store
 * @param is_many_to_many
 * @param joined
 * @returns
 */
function joinTo(right_iterable, attribute, store, is_many_to_many, joined: Map<any, any[]>) {
	return new right_iterable.constructor({
		[Symbol.iterator]() {
			let joined_iterator;
			let has_multi_part_keys;
			return {
				next() {
					if (!joined_iterator) {
						const right_property = attribute.relationship.to;
						return (async () => {
							const add_entry = (key, entry) => {
								let flat_key = key;
								if (Array.isArray(key)) {
									flat_key = flattenKey(key);
									has_multi_part_keys = true;
								}
								let entries_for_key = joined.get(flat_key);
								if (entries_for_key) entries_for_key.push(entry);
								else joined.set(flat_key, (entries_for_key = [entry]));
								if (key !== flat_key) entries_for_key.key = key;
							};
							let i = 0;
							// get all the ids of the related records
							// TODO: May consider manually iterating so that we don't need to do an await on every iteration
							for await (const entry of right_iterable) {
								const record = entry.value ?? store.get(entry.key ?? entry);
								const left_key = record?.[right_property];
								if (left_key == null) continue;
								if (joined.filters?.some((filter) => !filter(record))) continue;
								if (is_many_to_many) {
									for (let i = 0; i < left_key.length; i++) {
										add_entry(left_key[i], entry);
									}
								} else {
									add_entry(left_key, entry);
								}
								if (i++ > 100) {
									// yield the event turn every 100 ids. See below for more explanation
									await new Promise(setImmediate);
									i = 0;
								}
							}
							// if there are multi-part keys, we need to be able to get the original key from the key property on the entry array
							joined_iterator = (has_multi_part_keys ? joined : joined.keys())[Symbol.iterator]();
							return this.next();
						})();
					}
					const joined_entry = joined_iterator.next();
					if (joined_entry.done) return joined_entry;
					return {
						// if necessary, get the original key from the entries array
						value: has_multi_part_keys ? joined_entry.value[1].key || joined_entry.value[0] : joined_entry.value,
					};
				},
			};
		},
	});
}
/**
 * This is used to join the results of a query where the right side is a set of ids and the left side is a set of records
 * that have the foreign key (from left to right)
 * @param right_iterable
 * @param attribute
 * @param store
 * @param joined
 * @param search_entry
 * @returns
 */
function joinFrom(right_iterable, attribute, store, joined: Map<any, any[]>, search_entry) {
	return new right_iterable.constructor({
		[Symbol.iterator]() {
			let id_iterator;
			let joined_iterator;
			const seen_ids = new Set();
			return {
				next() {
					let joined_entry;
					if (joined_iterator) {
						while (true) {
							joined_entry = joined_iterator.next();
							if (joined_entry.done) break; // and continue to find next
							const id = flattenKey(joined_entry.value);
							if (seen_ids.has(id)) continue;
							seen_ids.add(id);
							return joined_entry;
						}
					}
					if (!id_iterator) {
						return (async () => {
							// get the ids of the related records as a Set so we can quickly check if it is in the set
							// when are iterating through the results
							const ids = new Map();
							// Define the fromRecord function so that we can use it to filter the related records
							// that are in the select(), to only those that are in this set of ids
							joined.fromRecord = (record) => {
								// TODO: Sort based on order ids
								return record[attribute.relationship.from]?.filter?.((id) => ids.has(flattenKey(id)));
							};
							let i = 0;
							// get all the ids of the related records
							// TODO: May consider manually iterating so that we don't need to do an await on every iteration
							for await (const id of right_iterable) {
								if (joined.filters) {
									// if additional filters are defined, we need to check them
									const record = store.get(id);
									if (joined.filters.some((filter) => !filter(record))) continue;
								}
								ids.set(flattenKey(id), id);
								if (i++ > 100) {
									// yield the event turn every 100 ids. We don't want to monopolize the
									// event loop, give others a chance to run. However, we are much more aggressive
									// about running here than in simple filter operations, because we are
									// executing a very minimal range iteration and because this is consuming
									// memory (so we want to get it over with) and the user isn't getting any
									// results until we finish
									await new Promise(setImmediate);
									i = 0;
								}
							}
							// and now start iterating through the ids
							id_iterator = ids.values()[Symbol.iterator]();
							return this.next();
						})();
					}
					do {
						const id_entry = id_iterator.next();
						if (id_entry.done) return id_entry;
						joined_iterator = search_entry(id_entry.value)[Symbol.iterator]();
						return this.next();
					} while (true);
				},
				return() {
					return joined_iterator?.return?.();
				},
				throw() {
					return joined_iterator?.throw?.();
				},
			};
		},
	});
}

const ALTERNATE_COMPARATOR_NAMES = {
	'greater_than': 'gt',
	'greater_than_equal': 'ge',
	'less_than': 'lt',
	'less_than_equal': 'le',
	'not_equal': 'ne',
	'equal': 'equals',
	'sw': 'starts_with',
	'ew': 'ends_with',
	'ct': 'contains',
	'>': 'gt',
	'>=': 'ge',
	'<': 'lt',
	'<=': 'le',
	'...': 'between',
};

/**
 * Create a filter based on the search condition that can be used to test each supplied record.
 * @param {SearchObject} search_condition
 * @returns {({}) => boolean}
 */
export function filterByType(search_condition, Table, context, filtered, is_primary_key?, estimated_incoming_count?) {
	if (search_condition.conditions) {
		// this is a group of conditions, we need to combine them
		const conditions = search_condition.conditions.map(filterByType);
		if (search_condition.operator === 'or') {
			return (record) => conditions.some((condition) => condition(record));
		} else {
			return (record) => conditions.every((condition) => condition(record));
		}
	}
	const comparator = search_condition.comparator;
	let attribute = search_condition[0] ?? search_condition.attribute;
	let value = search_condition[1] ?? search_condition.value;
	if (Array.isArray(attribute)) {
		if (attribute.length === 0) return () => true;
		if (attribute.length === 1) attribute = attribute[0];
		else if (attribute.length > 1) {
			const first_attribute_name = attribute[0];
			// get the relationship attribute
			const first_attribute = findAttribute(Table.attributes, first_attribute_name);
			const related_table = first_attribute.definition?.tableClass || first_attribute.elements.definition?.tableClass;
			// TODO: If this is a relationship, we can potentially make this more efficient by using the index
			// and retrieving the set of matching ids first
			const filter_map = filtered?.[first_attribute_name];
			const next_filter = filterByType(
				{
					attribute: attribute.length > 2 ? attribute.slice(1) : attribute[1],
					value,
					comparator,
				},
				related_table,
				context,
				filter_map?.[first_attribute_name]?.joined,
				attribute[1] === related_table.primaryKey,
				estimated_incoming_count
			);
			if (!next_filter) return;
			if (filter_map) {
				if (!filter_map.filters) filter_map.filters = [];
				filter_map.filters.push(next_filter);
				return;
			}
			const resolver = Table.propertyResolvers?.[first_attribute_name];
			return (record, entry) => {
				let sub_object, sub_entry;
				if (resolver) {
					sub_entry = resolver(record, context, entry);
					sub_object = sub_entry?.value;
				} else sub_object = record[first_attribute_name];
				if (!sub_object) return false;
				if (!Array.isArray(sub_object)) return next_filter(sub_object, sub_entry);
				return sub_object.some(next_filter);
			};
		}
	}
	if (value instanceof Date) value = value.getTime();

	switch (ALTERNATE_COMPARATOR_NAMES[comparator] || comparator) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
		case undefined:
			return attributeComparator(attribute, (record_value) => record_value === value, true);
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			return attributeComparator(attribute, (record_value) => record_value?.toString().includes(value));
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			return attributeComparator(attribute, (record_value) => record_value?.toString().endsWith(value));
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			return attributeComparator(
				attribute,
				(record_value) => typeof record_value === 'string' && record_value.startsWith(value),
				true
			);
		case 'prefix':
			if (!Array.isArray(value)) value = [value];
			else if (value[value.length - 1] == null) value = value.slice(0, -1);
			return attributeComparator(
				attribute,
				(record_value) => {
					if (!Array.isArray(record_value)) return false;
					for (let i = 0, l = value.length; i < l; i++) {
						if (record_value[i] !== value[i]) return false;
					}
					return true;
				},
				true
			);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			if (value[0] instanceof Date) value[0] = value[0].getTime();
			if (value[1] instanceof Date) value[1] = value[1].getTime();
			return attributeComparator(
				attribute,
				(record_value) => {
					return compareKeys(record_value, value[0]) >= 0 && compareKeys(record_value, value[1]) <= 0;
				},
				true
			);
		case 'gt':
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN:
			return attributeComparator(attribute, (record_value) => compareKeys(record_value, value) > 0);
		case 'ge':
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			return attributeComparator(attribute, (record_value) => compareKeys(record_value, value) >= 0);
		case lmdb_terms.SEARCH_TYPES.LESS_THAN:
		case 'lt':
		case lmdb_terms.SEARCH_TYPES._LESS_THAN:
			return attributeComparator(attribute, (record_value) => compareKeys(record_value, value) < 0);
		case 'le':
		case lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN_EQUAL:
			return attributeComparator(attribute, (record_value) => compareKeys(record_value, value) <= 0);
		case 'ne':
			return attributeComparator(attribute, (record_value) => compareKeys(record_value, value) !== 0);
		default:
			throw new ClientError(`Unknown query comparator "${comparator}"`);
	}
	/** Create a comparison function that can take the record and check the attribute's value with the filter function */
	function attributeComparator(attribute, filter, can_use_index?) {
		const threshold_remaining_misses = search_condition.estimated_count >> 4;
		can_use_index =
			can_use_index && // is it a comparator that makes sense to use index
			!is_primary_key && // no need to use index for primary keys, since we will be iterating over the primary keys
			Table?.indices[attribute] && // is there an index for this attribute
			threshold_remaining_misses > -1 && // do we have a valid estimate
			search_condition.estimated_count > 0;
		let misses = 0;
		let filtered_so_far = 5; // what we use to calculate miss rate; we give some buffer so we don't jump to indexed retrieval too quickly
		function recordFilter(record) {
			const value = record[attribute];
			let matches;
			if (typeof value !== 'object' || !value) matches = filter(value);
			else if (Array.isArray(value)) matches = value.some(filter);
			else if (value instanceof Date) matches = filter(value.getTime());
			//else matches = false;
			// As we are filtering, we can lazily/reactively switch to indexing if we are getting a low match rate, allowing use to load
			// a set of ids instead of loading each record. This can be a significant performance improvement for large queries with low match rates
			if (can_use_index) {
				filtered_so_far++;
				if (
					!matches &&
					!recordFilter.idFilter &&
					// miss rate x estimated remaining to filter > 10% of estimated incoming
					(++misses / filtered_so_far) * (estimated_incoming_count - filtered_so_far) > threshold_remaining_misses
				) {
					// if we have missed too many times, we need to switch to indexed retrieval
					const matching_ids = searchByIndex(search_condition, context.transaction, false, Table).map(flattenKey);
					// now generate a hash set that we can efficiently check primary keys against
					// TODO: Do this asynchronously
					const id_set = new Set(matching_ids);
					recordFilter.idFilter = (id) => id_set.has(flattenKey(id));
				}
			}
			return matches;
		}
		if (is_primary_key) {
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
				let estimated_count;
				if (condition.operator === 'or') {
					// with a union, we can just add the estimated counts
					estimated_count = 0;
					for (const sub_condition of condition.conditions) {
						estimateConditionForTable(sub_condition);
						estimated_count += sub_condition.estimated_count;
					}
				} else {
					// with an intersection, we have to use the rate of the sub-conditions to apply to estimate count of last condition
					estimated_count = Infinity;
					for (const sub_condition of condition.conditions) {
						estimateConditionForTable(sub_condition);
						estimated_count = isFinite(estimated_count)
							? (estimated_count * sub_condition.estimated_count) / estimatedEntryCount(table.primaryStore)
							: sub_condition.estimated_count;
					}
				}
				condition.estimated_count = estimated_count;
				return condition.estimated_count;
			}
			// skip if it is cached
			const search_type = condition.comparator || condition.search_type;
			if (search_type === lmdb_terms.SEARCH_TYPES.EQUALS || !search_type) {
				const attribute_name = condition[0] ?? condition.attribute;
				if (attribute_name == null || attribute_name === table.primaryKey) condition.estimated_count = 1;
				else {
					if (Array.isArray(attribute_name) && attribute_name.length > 1) {
						const attribute = findAttribute(table.attributes, attribute_name[0]);
						const related_table = attribute.definition?.tableClass || attribute.elements.definition?.tableClass;
						const estimate = estimateCondition(related_table)({
							value: condition.value,
							attribute: attribute_name.length > 2 ? attribute_name.slice(1) : attribute_name[1],
							comparator: 'equals',
						});
						condition.estimated_count =
							(estimate * estimatedEntryCount(table.indices[attribute.relationship.from] || table.primaryStore)) /
							(estimatedEntryCount(related_table.primaryStore) || 1);
					} else {
						// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
						const index = table.indices[attribute_name];
						condition.estimated_count = index ? index.getValuesCount(condition[1] ?? condition.value) : Infinity;
					}
				}
			} else if (
				search_type === lmdb_terms.SEARCH_TYPES.CONTAINS ||
				search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH ||
				search_type === 'ne'
			) {
				const attribute_name = condition[0] ?? condition.attribute;
				const index = table.indices[attribute_name];
				if (condition.value === null && search_type === 'ne') {
					condition.estimated_count =
						estimatedEntryCount(table.primaryStore) - (index ? index.getValuesCount(null) : 0);
				} else condition.estimated_count = Infinity;
				// for range queries (betweens, starts_with, greater, etc.), just arbitrarily guess
			} else if (search_type === lmdb_terms.SEARCH_TYPES.STARTS_WITH || search_type === 'prefix')
				condition.estimated_count = STARTS_WITH_ESTIMATE * estimatedEntryCount(table.primaryStore);
			else if (search_type === lmdb_terms.SEARCH_TYPES.BETWEEN)
				condition.estimated_count = BETWEEN_ESTIMATE * estimatedEntryCount(table.primaryStore);
			// for the search types that use the broadest range, try do them last
			else condition.estimated_count = OPEN_RANGE_ESTIMATE * estimatedEntryCount(table.primaryStore);
			// we give a condition significantly more weight/preference if we will be ordering by it
			if (typeof condition.descending === 'boolean') condition.estimated_count /= 4;
		}
		return condition.estimated_count; // use cached count
	}
	return estimateConditionForTable;
}
const NEEDS_PARSER = /[()[\]|!<>.]|(=\w+=)/;
const QUERY_PARSER = /([^?&|=<>!([{}\]),]*)([([{}\])|,&]|[=<>!]*)/g;
const VALUE_PARSER = /([^&|=[\]{}]+)([[\]{}]|[&|=]*)/g;
let last_index;
let query_string;
/**
 * This is responsible for taking a query string (from a get()) and converting it to a standard query object
 * structure
 * @param query_string
 */
export function parseQuery(query_to_parse) {
	if (!query_to_parse) return;
	query_string = query_to_parse;
	// TODO: We can remove this if we are sure all exits points end with lastIndex as zero (reaching the end of parsing will do that)
	QUERY_PARSER.lastIndex = 0;
	if (NEEDS_PARSER.test(query_to_parse)) {
		try {
			const query = parseBlock(new Query(), '');
			if (last_index !== query_string.length) throw new SyntaxError(`Unable to parse query, unexpected end of query`);
			return query;
		} catch (error) {
			error.statusCode = 400;
			error.message = `Unable to parse query, ${error.message} at position ${last_index} in '${query_string}'`;
			throw error;
		}
	} else {
		const query = new URLSearchParams(query_to_parse);
		query.conditions = query;
		return query;
	}
}
function parseBlock(query, expected_end) {
	let parser = QUERY_PARSER;
	let match;
	let attribute, comparator, expecting_delimiter, expecting_value;
	while ((match = parser.exec(query_string))) {
		last_index = parser.lastIndex;
		const [, value, operator] = match;
		if (expecting_delimiter) {
			if (value) throw new SyntaxError(`expected operator, but encountered '${value}'`);
			expecting_delimiter = false;
			expecting_value = false;
		} else expecting_value = true;
		let entry;
		switch (operator) {
			case '=':
				if (attribute) {
					// a FIQL operator like =gt= (and don't allow just any string)
					if (value.length <= 2) comparator = value;
					else throw new SyntaxError(`invalid FIQL operator ${value}`);
				} else {
					comparator = 'equals';
					if (!value) throw new SyntaxError(`attribute must be specified before equality comparator`);
					attribute = decodeProperty(value);
				}
				break;
			case '!=':
			case '<':
			case '<=':
			case '>':
			case '>=':
				comparator = SYMBOL_OPERATORS[operator];
				if (!value) throw new SyntaxError(`attribute must be specified before comparator ${operator}`);
				attribute = decodeProperty(value);
				break;
			case '|':
				query.operator = 'or';
			// fall through
			case '':
			case undefined:
			case '&':
				if (attribute == null) {
					if (attribute === undefined) {
						if (expected_end)
							throw new SyntaxError(
								`expected '${expected_end}', but encountered ${
									operator[0] ? "'" + operator[0] + "'" : 'end of string'
								}}`
							);
						throw new SyntaxError(
							`no comparison specified before ${operator ? "'" + operator + "'" : 'end of string'}`
						);
					}
				} else {
					if (!query.conditions) throw new SyntaxError('conditions/comparisons are not allowed in a property list');
					query.conditions.push({
						comparator: comparator,
						attribute,
						value: decodeURIComponent(value),
					});
				}
				attribute = undefined;
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
				QUERY_PARSER.lastIndex = last_index;
				const args = parseBlock(value ? [] : new Query(), ')');
				switch (value) {
					case '': // nested/grouped condition
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
				if (query_string[last_index] === ',') {
					parser.lastIndex = ++last_index;
				} else expecting_delimiter = true;
				attribute = null;
				break;
			case '{':
				if (query.conditions) throw new SyntaxError('property sets are not allowed in a queries');
				if (!value) throw new SyntaxError('property sets must have a defined parent property name');
				// this is interpreted as property{subProperty}
				QUERY_PARSER.lastIndex = last_index;
				entry = parseBlock([], '}');
				entry.name = value;
				query.push(entry);
				if (query_string[last_index] === ',') {
					parser.lastIndex = ++last_index;
				} else expecting_delimiter = true;
				break;
			case '[':
				QUERY_PARSER.lastIndex = last_index;
				if (value) {
					// this is interpreted as propertyWithArray[name=value&anotherOtherConditions...]
					entry = parseBlock(new Query(), ']');
					entry.name = value;
				} else {
					// this is interpreted a property list that can be used within other lists
					entry = parseBlock(query.conditions ? new Query() : [], ']');
				}
				if (query.conditions) {
					query.conditions.push(entry);
					attribute = null;
				} else query.push(entry);
				if (query_string[last_index] === ',') {
					parser.lastIndex = ++last_index;
				} else expecting_delimiter = true;
				break;
			case ')':
			case ']':
			case '}':
				if (expected_end === operator[0]) {
					// assert that it is expected
					if (query.conditions) {
						// finish condition
						if (attribute) {
							query.conditions.push({
								comparator: comparator || 'equals',
								attribute,
								value: decodeURIComponent(value),
							});
						} else if (value) {
							throw new SyntaxError('no attribute or comparison specified');
						}
					} else if (value || (query.length > 0 && expecting_value)) {
						query.push(decodeProperty(value));
					}
					return query;
				} else if (expected_end) throw new SyntaxError(`expected '${expected_end}', but encountered '${operator[0]}'`);
				else throw new SyntaxError(`unexpected token '${operator[0]}'`);
			default:
				throw new SyntaxError(`unexpected operator '${operator}'`);
		}
		if (expected_end !== ')') {
			parser = attribute ? VALUE_PARSER : QUERY_PARSER;
			parser.lastIndex = last_index;
		}
		if (last_index === query_string.length) return query;
	}
	if (expected_end) throw new SyntaxError(`expected '${expected_end}', but encountered end of string`);
}

function decodeProperty(name) {
	if (name.indexOf('.') > -1) {
		return name.split('.').map(decodeProperty);
	}
	return decodeURIComponent(name);
}

function toSortObject(sort) {
	const sort_object = toSortEntry(sort[0]);
	if (sort.length > 1) {
		sort_object.next = toSortObject(sort.slice(1));
	}
	return sort_object;
}
function toSortEntry(sort) {
	if (Array.isArray(sort)) {
		const sort_object = toSortEntry(sort[0]);
		sort[0] = sort_object.attribute;
		sort_object.attribute = sort;
		return sort_object;
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
