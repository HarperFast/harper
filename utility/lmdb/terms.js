'use strict';

const INTERNAL_DBIS_NAME = '__dbis__';
const ENVIRONMENT_NAME_KEY = '__environment_name__';
const BLOB_DBI_NAME = '__blob__';
const DBI_DEFINITION_NAME = '__dbi_defintion__';
const MAX_BYTE_SIZE = 254;

const SEARCH_TYPES = {
  EQUALS: 'equals',
  STARTS_WITH: 'startsWith',
  ENDS_WITH: 'endsWith',
  CONTAINS: 'contains',
  SEARCH_ALL: 'searchAll',
  SEARCH_ALL_TO_MAP: 'searchAllToMap',
  BATCH_SEARCH_BY_HASH: 'batchSearchByHash',
  BATCH_SEARCH_BY_HASH_TO_MAP: 'batchSearchByHashToMap',
  GREATER_THAN: 'greaterThan',
  GREATER_THAN_EQUAL: 'greaterThanEqual',
  LESS_THAN: 'lessThan',
  LESS_THAN_EQUAL: 'lessThanEqual',
  BETWEEN: 'between'
};

const TIMESTAMP_NAMES = ['__createdtime__', '__updatedtime__'];

const TRANSACTIONS_DBI_NAMES_ENUM = {
  TIMESTAMP: 'timestamp',
  HASH_VALUE: 'hash_value',
  USER_NAME: 'user_name'
};

const TRANSACTIONS_DBIS = Object.values(TRANSACTIONS_DBI_NAMES_ENUM);

module.exports = {
  INTERNAL_DBIS_NAME,
  DBI_DEFINITION_NAME,
  SEARCH_TYPES,
  TIMESTAMP_NAMES,
  BLOB_DBI_NAME,
  MAX_BYTE_SIZE,
  ENVIRONMENT_NAME_KEY,
  TRANSACTIONS_DBI_NAMES_ENUM,
  TRANSACTIONS_DBIS
};