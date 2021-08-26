'use strict';

const is_compiled = process.env.HDB_COMPILED === 'true';
if (is_compiled) {
    require('bytenode');
    require('../server/jobThread.jsc');
} else {
    require('../server/jobThread');
}