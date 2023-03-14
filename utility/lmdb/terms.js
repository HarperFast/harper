'use strict';

const INTERNAL_DBIS_NAME = '__dbis__';
const AUDIT_STORE_NAME = '__txns__';
const ENVIRONMENT_NAME_KEY = '__environment_name__';
const DBI_DEFINITION_NAME = '__dbi_defintion__';
//LMDB has a 1978 byte limit for keys, but we try to retain plenty of padding so we don't have to calculate encoded byte length
const MAX_SEARCH_KEY_LENGTH = 256;

const SEARCH_TYPES = {
	EQUALS: 'equals',
	STARTS_WITH: 'startsWith',
	_STARTS_WITH: 'starts_with',
	ENDS_WITH: 'endsWith',
	_ENDS_WITH: 'ends_with',
	CONTAINS: 'contains',
	SEARCH_ALL: 'searchAll',
	SEARCH_ALL_TO_MAP: 'searchAllToMap',
	BATCH_SEARCH_BY_HASH: 'batchSearchByHash',
	BATCH_SEARCH_BY_HASH_TO_MAP: 'batchSearchByHashToMap',
	GREATER_THAN: 'greaterThan',
	_GREATER_THAN: 'greater_than',
	GREATER_THAN_EQUAL: 'greaterThanEqual',
	_GREATER_THAN_EQUAL: 'greater_than_equal',
	LESS_THAN: 'lessThan',
	_LESS_THAN: 'less_than',
	LESS_THAN_EQUAL: 'lessThanEqual',
	_LESS_THAN_EQUAL: 'less_than_equal',
	BETWEEN: 'between',
};

const TIMESTAMP_NAMES = ['__createdtime__', '__updatedtime__'];
// This is appended to the end of keys that are larger than the max key size, as a marker to indicate
// the full value must be retrieved from the full record (from the hash/primary dbi) for operations
// that require the full value (contains and ends-with operators).
const OVERFLOW_MARKER = '\uffff';

const TRANSACTIONS_DBI_NAMES_ENUM = {
	TIMESTAMP: 'timestamp',
	HASH_VALUE: 'hash_value',
	USER_NAME: 'user_name',
};

const TRANSACTIONS_DBIS = Object.values(TRANSACTIONS_DBI_NAMES_ENUM);

module.exports = {
	AUDIT_STORE_NAME,
	INTERNAL_DBIS_NAME,
	DBI_DEFINITION_NAME,
	SEARCH_TYPES,
	TIMESTAMP_NAMES,
	MAX_SEARCH_KEY_LENGTH,
	ENVIRONMENT_NAME_KEY,
	TRANSACTIONS_DBI_NAMES_ENUM,
	TRANSACTIONS_DBIS,
	OVERFLOW_MARKER,
};
