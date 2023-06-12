import { ClientError } from '../utility/errors/hdbError';
import * as lmdb_terms from '../utility/lmdb/terms';
import { compareKeys } from 'ordered-binary';
import { SKIP } from 'lmdb';

export function idsForCondition(search_condition, transaction, reverse, Table, allow_full_scan) {
	const attribute_name = search_condition[0] ?? search_condition.attribute;
	let start;
	let end, inclusiveEnd, exclusiveStart;
	const value = search_condition[1] ?? search_condition.value;
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
		case 'starts_with':
			start = value.toString();
			end = value + String.fromCharCode(0xffff);
			break;
		case 'between':
			start = value[0];
			end = value[1];
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
	const index = attribute_name === Table.primaryKey ? Table.primaryStore : Table.indices[attribute_name];

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
			.map(({ key, value }) => new Promise((resolve) => setImmediate(() => resolve(filter(value) ? SKIP : key))));
	}
	const is_primary_key = attribute_name === Table.primaryKey;
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
	const value = search_condition[1] ?? search_condition.value;

	switch (search_type) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
			return (record) => record[attribute] === value;
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			return (record) => record[attribute]?.toString().includes(value);
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			return (record) => record[attribute]?.toString().endsWith(value);
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].startsWith(value);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			return (record) => {
				const record_value = record[attribute];
				return compareKeys(record_value, value[0]) >= 0 && compareKeys(record_value, value[1]) <= 0;
			};
		case 'gt':
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN:
			return (record) => compareKeys(record[attribute], value) > 0;
		case 'ge':
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], value) >= 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN:
		case 'lt':
		case lmdb_terms.SEARCH_TYPES._LESS_THAN:
			return (record) => compareKeys(record[attribute], value) < 0;
		case 'le':
		case lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], value) <= 0;
		case 'ne':
			return (record) => record[attribute] !== value;
		default:
			return; // Object.create(null);
	}
}
