"use strict";

const common = require('../../../utility/lmdb/commonUtility');
const assert = require('assert');

const ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:'46'}
];

describe("Test commonUtility module", ()=>{
    describe("Test stringifyData function", ()=>{
        it("pass variables resolving to null", ()=>{
            let err;
            let response;
            let response1;
            let response2;
            let response3;
            try {
                response = common.stringifyData();
                response1 = common.stringifyData(undefined);
                response2 = common.stringifyData(null);
                response3 = common.stringifyData('');
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(response, null);
            assert.deepStrictEqual(response1, null);
            assert.deepStrictEqual(response2, null);
            assert.deepStrictEqual(response3, null);
        });

        it("pass booleans", ()=>{
            let err;
            let response;
            let response1;
            try {
                response = common.stringifyData(true);
                response1 = common.stringifyData(false);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(response, 'true');
            assert.deepStrictEqual(response1, 'false');
        });

        it("pass arrays and object", ()=>{
            const string_array = ['a', 'bb', 'zz', 'aa111'];
            const numeric_array = [1, 100, 8.43, 7965, 22.6789];
            const mixed_type_array = [300, false, 'test', 55.532, 'stuff'];

            let err;
            let response;
            let response1;
            let response2;
            let response3;
            let response4;
            try {
                response = common.stringifyData(string_array);
                response1 = common.stringifyData(numeric_array);
                response2 = common.stringifyData(mixed_type_array);
                response3 = common.stringifyData(ONE_RECORD_ARRAY);
                response4 = common.stringifyData(ONE_RECORD_ARRAY[0]);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(response, JSON.stringify(string_array));
            assert.deepStrictEqual(response1, JSON.stringify(numeric_array));
            assert.deepStrictEqual(response2, JSON.stringify(mixed_type_array));
            assert.deepStrictEqual(response3, JSON.stringify(ONE_RECORD_ARRAY));
            assert.deepStrictEqual(response4, JSON.stringify(ONE_RECORD_ARRAY[0]));
        });

        it("test 511 character limit", ()=>{
            const string_254 = 'Fam 3 wolf moon hammocks pinterest, man braid austin hoodie you probably haven\'t heard of them schlitz polaroid XOXO butcher. Flexitarian leggings cold-pressed live-edge jean shorts plaid, pickled vegan raclette 8-bit literally. Chambray you probably hav';
            const string_255 = string_254 + 'i';
            let err;
            let response;
            let response1;
            try {
                response = common.stringifyData(string_254);
                response1 = common.stringifyData(string_255);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(Buffer.byteLength(string_254), 254);
            assert.deepStrictEqual(Buffer.byteLength(string_255), 255);
            assert.deepStrictEqual(response, string_254);
            assert.deepStrictEqual(response1, string_255);
        });
    });
});