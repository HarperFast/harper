import { ClientError } from '../utility/errors/hdbError';
import * as lmdb_terms from '../utility/lmdb/terms';
import { compareKeys, MAXIMUM_KEY } from 'ordered-binary';
import { SKIP } from 'lmdb';
import { Request } from './ResourceInterface';

const QUERY_PARSER = /([^?&|=<>!()*]+)([&|=<>!()*]*)/g;
const SYMBOL_OPERATORS = {
	'<': 'lt',
	'<=': 'le',
	'>': 'gt',
	'>=': 'ge',
	'!=': 'ne',
};

export function idsForCondition(search_condition, transaction, reverse, Table, allow_full_scan) {
	const attribute_name = search_condition[0] ?? search_condition.attribute;
	let start;
	let end, inclusiveEnd, exclusiveStart;
	let value = search_condition[1] ?? search_condition.value;
	if (value instanceof Date) value = value.getTime();
	const comparator = search_condition.comparator;
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
		case 'prefix':
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
		case 'contains':
		case 'ends_with':
			// we have to revert to full table scan here
			need_full_scan = true;
			break;
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

	if (!index || index.isIndexing || need_full_scan) {
		// no indexed searching available, need a full scan
		if (!allow_full_scan)
			throw new ClientError(
				`"${attribute_name}" is not indexed${index?.isIndexing ? ' yet' : ''}, can not search for this attribute`,
				404
			);
		const filter = filterByType(search_condition);
		if (!filter) {
			throw new ClientError(`Unknown search operator ${search_condition.comparator}`);
		}
		// for filter operations, we intentionally yield the event turn so that scanning queries
		// do not hog resources
		return Table.primaryStore
			.getRange({ start: true, transaction, reverse })
			.map(({ key, value }) => new Promise((resolve) => setImmediate(() => resolve(filter(value) ? key : SKIP))));
	}
	const range_options = { start, end, inclusiveEnd, exclusiveStart, values: !is_primary_key, transaction, reverse };
	if (is_primary_key) {
		return index.getRange(range_options);
	} else {
		return index.getRange(range_options).map(({ value }) => value);
	}
}
const ALTERNATE_COMPARATOR_NAMES = {
	'greater_than': 'gt',
	'greater_than_equal': 'ge',
	'less_than': 'lt',
	'less_than_equal': 'le',
	'not_equal': 'ne',
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
export function filterByType(search_condition) {
	const search_type = search_condition.comparator;
	const attribute = search_condition[0] ?? search_condition.attribute;
	let value = search_condition[1] ?? search_condition.value;
	if (value instanceof Date) value = value.getTime();

	switch (search_type) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
			return attributeComparator(attribute, (record_value) => record_value === value);
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			return attributeComparator(attribute, (record_value) => record_value?.toString().includes(value));
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			return attributeComparator(attribute, (record_value) => record_value?.toString().endsWith(value));
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			return attributeComparator(
				attribute,
				(record_value) => typeof record_value === 'string' && record_value.startsWith(value)
			);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			if (value[0] instanceof Date) value[0] = value[0].getTime();
			if (value[1] instanceof Date) value[1] = value[1].getTime();
			return attributeComparator(attribute, (record_value) => {
				return compareKeys(record_value, value[0]) >= 0 && compareKeys(record_value, value[1]) <= 0;
			});
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
			return; // Object.create(null);
	}
}
/** Create a comparison function that can take the record and check the attribute's value with the filter function */
function attributeComparator(attribute, filter) {
	return (record) => {
		const value = record[attribute];
		if (typeof value !== 'object' || !value) return filter(value);
		if (Array.isArray(value)) return value.some(filter);
		if (value instanceof Date) return filter(value.getTime());
		return false;
	};
}

/**
 * This is responsible for taking a query string (from a get()) and converting it to a standard query object
 * structure
 * @param query_string
 */
export function parseQuery(query_string) {
	if (!query_string) return;
	const query = [];
	let match;
	let attribute, comparator;
	let last_index;
	let call;
	// TODO: Use URLSearchParams with a fallback for when it can parse everything (USP is very fast)
	while ((match = QUERY_PARSER.exec(query_string))) {
		last_index = QUERY_PARSER.lastIndex;
		const [, value, operator] = match;
		switch (operator) {
			case ')':
				// finish call
				switch (call) {
					case 'limit':
						if (value.indexOf(',') > -1) {
							const [start, end] = value.split(',');
							query.offset = +start;
							query.limit = end - query.offset;
						} else query.limit = +value;
						break;
					case 'select':
						if (value[0] === '[') {
							if (value[value.length - 1] !== ']') throw new Error('Unmatched brackets');
							query.select = value.slice(1, -1).split(',');
							query.select.asArray = true;
						} else if (value.indexOf(',') > -1) {
							query.select = (value.endsWith(',') ? value.slice(0, -1) : value).split(',');
						} else query.select = value;
						break;
					case 'group-by':
						throw new Error('Group by is not implemented yet');
					case 'sort':
						query.sort = value.split(',').map((direction) => {
							switch (direction[0]) {
								case '-':
									return { attribute: direction.slice(1), descending: true };
								case '+':
									return { attribute: direction.slice(1), descending: false };
								default:
									return { attribute: direction, descending: false };
							}
						});
						break;
					default:
						throw new Error(`Unknown query function call ${call}`);
				}
				break;
			case '(':
				call = value;
				break;
			case '=':
				if (attribute) {
					// a FIQL operator like =gt= (and don't allow just any string)
					if (value.length <= 2) comparator = value;
				} else {
					comparator = 'equals';
					attribute = decodeURIComponent(value);
				}
				break;
			case '!=':
			case '<':
			case '<=':
			case '>':
			case '>=':
				comparator = SYMBOL_OPERATORS[operator];
				attribute = decodeURIComponent(value);
				break;
			case '=*':
				comparator = 'ends_with';
				attribute = decodeURIComponent(value);
				break;
			case '*':
			case '*&':
				query.push({
					comparator: comparator === 'ends_with' ? 'contains' : 'starts_with',
					attribute,
					value: decodeURIComponent(value),
				});
				attribute = null;
				break;
			case '':
			case undefined:
			case '&':
			case '|':
				if (!attribute)
					throw new Error(`Unable to parse query, no part before ${operator} at ${last_index} in ${query_string}`);
				query.push({
					comparator: comparator,
					attribute,
					value: decodeURIComponent(value),
				});
				attribute = undefined;
				break;
			default:
				throw new Error(`Unknown operator ${operator} in query ${query_string}`);
		}
	}
	if (last_index !== query_string.length) throw new Error(`Unable to parse query, unexpected end in ${query_string}`);
	return query;
}
