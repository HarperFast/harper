'use strict';

const is_compiled = process.env.HDB_COMPILED === 'true';
if (is_compiled) {
    require('bytenode');
    require('../server/customFunctions/customFunctionsServer.jsc');
} else {
    require('../server/customFunctions/customFunctionsServer');
}