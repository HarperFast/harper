'use strict';

const env_mgr = require('../../../../../utility/environment/environmentManager');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const path = require('path');

env_mgr.setProperty('HDB_ROOT', path.resolve(__dirname, '../../../../envDir'));

const orig_thread_search = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbThreadSearch');

process.on('message', orig_thread_search);