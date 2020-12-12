'use strict';

const HDB_SETTINGS_KEYS = Object.keys(require('../utility/hdbTerms').HDB_SETTINGS_NAMES_REVERSE_LOOKUP);
const env = require('../utility/environment/environmentManager');
env.initSync();

module.exports = {
    getConfiguration
};

/**
 * this function returns all of the config settings
 * @returns {{}}
 */
function getConfiguration(){
    let result = {};
    for(let x = 0, length = HDB_SETTINGS_KEYS.length; x < length; x++){
        let key = HDB_SETTINGS_KEYS[x];
        result[key] = env.getProperty(key);
    }

    return result;
}
