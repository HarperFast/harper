#!/usr/bin/env node
'use strict';
process.env.HDB_COMPILED='true';
const bytenode = require('bytenode');
console.log('require harperdb.jsc');
require('./harperdb.jsc');
