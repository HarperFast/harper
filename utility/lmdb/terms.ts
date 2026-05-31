'use strict';

export const INTERNAL_DBIS_NAME = '__dbis__';
export const AUDIT_STORE_NAME = '__txns__';
export const ENVIRONMENT_NAME_KEY = '__environment_name__';
export const DBI_DEFINITION_NAME = '__dbi_defintion__';
//LMDB has a 1978 byte limit for keys, but we try to retain plenty of padding so we don't have to calculate encoded byte length
export const MAX_SEARCH_KEY_LENGTH = 256;

export const SEARCH_TYPES = {
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

export const TIMESTAMP_NAMES = ['__createdtime__', '__updatedtime__'];
// This is appended to the end of keys that are larger than the max key size, as a marker to indicate
// the full value must be retrieved from the full record (from the hash/primary dbi) for operations
// that require the full value (contains and ends-with operators).
export const OVERFLOW_MARKER = '\uffff';

export const TRANSACTIONS_DBI_NAMES_ENUM = {
	TIMESTAMP: 'timestamp',
	HASH_VALUE: 'hash_value',
	USER_NAME: 'user_name',
};

export const TRANSACTIONS_DBIS = Object.values(TRANSACTIONS_DBI_NAMES_ENUM);
