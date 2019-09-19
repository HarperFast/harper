"use strict";

const rewire = require('rewire');
const helium_utils = rewire('../../../utility/helium/heliumUtils');
const assert = require('assert');

const env = require('../../../utility/environment/environmentManager');
env.initSync();
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

const ENV_MNGR_PROPS = {
    HELIUM_VOLUME_PATH: '/tmp/hdb',
    HELIUM_SERVER_HOST: 'localhost:41000'
};

const FS_CONSTANTS = {
    F_OK: 1,
    R_OK: 2,
    W_OK: 3
};

describe('test heliumUtils', ()=>{
    describe('test getHeliumServerURL', ()=>{
        it('test no HELIUM_VOLUME_PATH', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", null);

            assert.rejects(async ()=>{
                await helium_utils.getHeliumServerURL();
            }, new Error('HELIUM_VOLUME_PATH must be defined in config settings.'));
        });

        it('test no HELIUM_SERVER_HOST', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", null);

            assert.rejects(async ()=>{
                await helium_utils.getHeliumServerURL();
            }, new Error('HELIUM_SERVER_HOST must be defined in config settings.'));
        });

        it('test invalid volume path', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let error = new Error('not found');
            error.code = 'ENOENT';

            let revert_fs = helium_utils.__set__('fs', {
                constants:FS_CONSTANTS,
                access:(path)=>{
                    throw error;
                }
            });
            assert.rejects(async ()=>{
                await helium_utils.getHeliumServerURL();
            }, new Error('invalid path defined in HELIUM_VOLUME_PATH'));
            revert_fs();
        });

        it('test fs access fail', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let error_msg = 'i failed';
            let error = new Error(error_msg);

            let revert_fs = helium_utils.__set__('fs', {
                constants:FS_CONSTANTS,
                access:(path)=>{
                    throw error;
                }
            });
            assert.rejects(async ()=>{
                await helium_utils.getHeliumServerURL();
            }, new Error(error_msg));
            revert_fs();
        });

        it('test happy path', async ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let revert_fs = helium_utils.__set__('fs', {
                constants:FS_CONSTANTS,
                access:(path)=>{

                }
            });
            let helium_url = await helium_utils.getHeliumServerURL();

            assert.equal(helium_url, 'he://' + ENV_MNGR_PROPS.HELIUM_SERVER_HOST + '/' + ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);

            revert_fs();
        });
    });

    describe('test initializeHelium', ()=>{

        it('test all good', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let revert_fs = helium_utils.__set__('fs', {
                constants:FS_CONSTANTS,
                access:(path)=>{

                }
            });

            let revert_helium = helium_utils.__set__('harperdb_helium', HarperDBHelium);

            let helium;
            assert.doesNotThrow(()=>{
                helium = helium_utils.initializeHelium();
            });

            assert.deepEqual(helium instanceof HarperDBHelium, true);

            revert_helium();
            revert_fs();
        });
    });

    it('test terminateHelium', ()=>{
        env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
        env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

        let revert_fs = helium_utils.__set__('fs', {
            constants:FS_CONSTANTS,
            access:(path)=>{

            }
        });
        let helium = new HarperDBHelium(false);

        assert.doesNotThrow(()=> {
            helium_utils.terminateHelium(helium);
        });

        revert_fs();
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
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let revert_helium = helium_utils.__set__('harperdb_helium', HarperDBHelium);

            assert.doesNotThrow(()=>{
                helium_utils.createSystemDataStores();
            });
            revert_helium();
        });
    });
});
