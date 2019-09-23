"use strict";

const test_util = require('../../test_utils');
test_util.preTestPrep();
const rewire = require('rewire');
const utils = require('../../../utility/common_utils');

const helium_utils = rewire('../../../utility/helium/heliumUtils');
const assert = require('assert');

const env = require('../../../utility/environment/environmentManager');

class HarperDBHelium {
    constructor(debug){

    }

    startSession(url) {
        return [0, "HE_ERR_OK"];
    }

    stopSession(url){

    }

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

const PSLIST_HELIUM_RETURN = [
    {
        "pid": 30112,
        "name": "helium",
        "cmd": "helium --server",
        "ppid": 1,
        "uid": 1000,
        "cpu": 0.2,
        "memory": 0
    }
];

describe('test heliumUtils', ()=>{
    describe('test getHeliumServerURL', ()=>{
        beforeEach(function () {
            helium_utils.__set__('helium_server_url', undefined);
        });

        it('test no HELIUM_VOLUME_PATH', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", null);
            let err = undefined;
            try {
                helium_utils.getHeliumServerURL();
            } catch(e){
                err = e;
            }
            assert.deepEqual(err, new Error('HELIUM_VOLUME_PATH must be defined in config settings.'));
        });

        it('test no HELIUM_SERVER_HOST', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", null);

            let err = undefined;
            try {
                helium_utils.getHeliumServerURL();
            } catch(e){
                err = e;
            }
            assert.deepEqual(err, new Error('HELIUM_SERVER_HOST must be defined in config settings.'));
        });

        it('test happy path', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let helium_url = helium_utils.getHeliumServerURL();

            assert.equal(helium_url, 'he://' + ENV_MNGR_PROPS.HELIUM_SERVER_HOST + '/' + ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
        });
    });

    describe('test initializeHelium', ()=>{

        it('test all good', ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let revert_helium = helium_utils.__set__('harperdb_helium', HarperDBHelium);

            let helium = helium_utils.initializeHelium();

            assert.deepEqual(helium instanceof HarperDBHelium, true);

            revert_helium();
        });
    });

    it('test terminateHelium',  ()=>{
        env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
        env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

        let helium = new HarperDBHelium(false);

        assert.doesNotReject(async ()=> {
            await helium_utils.terminateHelium(helium);
        });
    });

    describe('test createSystemDataStores', ()=>{
        it('test with fail', ()=>{


            let err = undefined;
            try {
                helium_utils.createSystemDataStores(new HarperDBHeliumBad(false));
            }catch(e){
                err = e;
            }

            assert.deepEqual(err, new Error('FAIL!'));
        });

        it('test all good', ()=>{
            assert.doesNotThrow(()=>{
                helium_utils.createSystemDataStores(new HarperDBHelium(false));
            });
        });
    });

    describe('Test checkHeliumServerRunning', ()=>{
        it('Test helium already running on localhost successfully', async ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let pslist_rewire = helium_utils.__set__('ps_list', {
                findPs: async (name)=>{
                    return PSLIST_HELIUM_RETURN;
                }
            });

            let init_helium_rewire = helium_utils.__set__('initializeHelium', ()=>{
                return new HarperDBHelium(false);
            });

            let err = undefined;
            try {
                await helium_utils.checkHeliumServerRunning();
            } catch(e){
                err = e;
            }

            assert.equal(err, undefined);

            pslist_rewire();
            init_helium_rewire();
        });

        it('Test helium not running on localhost successfully', async ()=>{
            env.setProperty("HELIUM_VOLUME_PATH", ENV_MNGR_PROPS.HELIUM_VOLUME_PATH);
            env.setProperty("HELIUM_SERVER_HOST", ENV_MNGR_PROPS.HELIUM_SERVER_HOST);

            let pslist_rewire = helium_utils.__set__('ps_list', {
                findPs: async (name)=>{
                    return [];
                }
            });

            let init_helium_rewire = helium_utils.__set__('initializeHelium', ()=>{
                return new HarperDBHelium(false);
            });

            let utils_rewire = helium_utils.__set__('utils', {
                isEmptyOrZeroLength: utils.isEmptyOrZeroLength,
                checkProcessRunning: async(name)=>{

                }
            });

            let err = undefined;
            try {
                await helium_utils.checkHeliumServerRunning();
            } catch(e){
                err = e;
            }

            assert.equal(err, undefined);

            pslist_rewire();
            init_helium_rewire();
            utils_rewire();
        });
    });
});
