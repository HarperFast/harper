'use strict';

const INTERNAL_DBIS_NAME = '__dbis__';
const DBI_DEFINITION_NAME = '__dbi_defintion__';

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

module.exports = {
  INTERNAL_DBIS_NAME,
  DBI_DEFINITION_NAME,
  SEARCH_TYPES
};