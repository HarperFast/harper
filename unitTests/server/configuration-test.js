'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const assert = require('assert');
const configuration = require('../../server/configuration');

describe('test getConfiguration function', ()=>{

    it('test happy path', ()=>{
        let err;
        let result;
        try {
            result = configuration.getConfiguration();
        }catch(e){
            err = e;
        }
        assert.deepStrictEqual(err, undefined);
        assert(typeof result === 'object');
    });
});