"use strict";

const rewire = require('rewire');
const helium_utils = rewire('../../../utility/helium/heliumUtils');
const assert = require('assert');

class HarperDBHelium {
    constructor(debug){

    }

    startSession() {
        return [0, "HE_ERR_OK"];
    }

    stopSession(){}

    createDataStores(data_stores){}
}

class HarperDBHeliumBad {
    constructor(debug){

    }

    startSession() {
        return [0, "HE_ERR_FAIL"];
    }

    stopSession(){

    }

    createDataStores(data_stores){
        throw new Error('FAIL!');
    }
}

describe('test heliumUtils', ()=>{
    describe('test initializeHelium', ()=>{
        it('test no HELIUM_VOLUME_PATH', ()=>{
           let revert = helium_utils.__set__('env', {
                get: ()=>{
                    return null;
                }
            });
           assert.throws(()=>{
               helium_utils.initializeHelium();
           });

            revert();
        });

        it('test HELIUM_VOLUME_PATH that fails', ()=>{
            let revert = helium_utils.__set__('env', {
                get:()=>{
                    return '/tmp/hdb';
                }
            });

            let revert_helium = helium_utils.__set__('harperdb_helium', HarperDBHeliumBad);

            assert.throws(()=>{
                helium_utils.initializeHelium();
            });

            revert();
            revert_helium();
        });

        it('test all good', ()=>{
            let revert = helium_utils.__set__('env', {
                get:()=>{
                    return '/tmp/hdb';
                }
            });

            let revert_helium = helium_utils.__set__('harperdb_helium', HarperDBHelium);

            let helium;
            assert.doesNotThrow(()=>{
                helium = helium_utils.initializeHelium();
            });

            assert.deepEqual(helium instanceof HarperDBHelium, true);

            revert();
            revert_helium();
        });
    });

    it('test terminateHelium', ()=>{
        let helium = new HarperDBHelium(false);

        assert.doesNotThrow(()=> {
            helium_utils.terminateHelium(helium);
        });
    });

    describe('test createSystemDataStores', ()=>{
        it('test with fail', ()=>{
            let revert_helium = helium_utils.__set__('harperdb_helium', HarperDBHeliumBad);

            assert.throws(()=>{
                helium_utils.createSystemDataStores();
            });

            revert_helium();
        });

        it('test all good', ()=>{
            let revert = helium_utils.__set__('env', {
                get:()=>{
                    return '/tmp/hdb';
                }
            });

            let revert_helium = helium_utils.__set__('harperdb_helium', HarperDBHelium);

            assert.doesNotThrow(()=>{
                helium_utils.createSystemDataStores();
            });
            revert();
            revert_helium();
        });
    });
});
