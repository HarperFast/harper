'use strict';

const _ = require('lodash');

module.exports = (result, terms) => result.map(record => _.pick(record, terms));
