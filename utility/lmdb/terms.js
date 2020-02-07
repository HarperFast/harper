'use strict';

const _ = require('lodash');

const INTERNAL_DBIS_NAME = '__dbis__';
const DBI_DEFINITION_NAME = '__dbi_defintion__';

const SEARCH_COMPARATORS = {
  LESS: "<",
  LESS_OR_EQ: "<=",
  GREATER: ">",
  GREATER_OR_EQ: ">=",
  BETWEEN: "..."
};
const SEARCH_COMPARATORS_REVERSE_LOOKUP = _.invert(SEARCH_COMPARATORS);

const SEARCH_TYPES = {
  EQUALS: 'equals',
  STARTS_WITH: 'startsWith',
  ENDS_WITH: 'endsWith',
  CONTAINS: 'contains',
  SEARCH_ALL: 'searchAll',
  SEARCH_ALL_TO_MAP: 'searchAllToMap',
  BATCH_SEARCH_BY_HASH: 'batchSearchByHash',
  BATCH_SEARCH_BY_HASH_TO_MAP: 'batchSearchByHashToMap'
};

module.exports = {
  INTERNAL_DBIS_NAME,
  DBI_DEFINITION_NAME,
  SEARCH_COMPARATORS,
  SEARCH_COMPARATORS_REVERSE_LOOKUP,
  SEARCH_TYPES
};