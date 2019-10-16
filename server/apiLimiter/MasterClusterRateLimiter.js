"use strict";

const log = require('../../utility/logging/harper_logger');
const crypto = require('crypto');
const registration_handler = require('../../utility/registration/registrationHandler');
const path = require('path');
const fs = require('fs-extra');
const CounterObject = require('./CounterObject');
const terms = require('../../utility/hdbTerms');
const {inspect} = require('util');

/*
* This class should be used by hdb_express to store the rate limits whenever needed.
*/

let fingerprint = undefined;

/**
 * Store the curr api count to path
 * @param count - A CounterObject type with the count to store
 * @param path - The path to store to
 * @returns {Promise<void>}
 */
async function saveApiCallCount(count, loc) {
    try {
        let finger = await registration_handler.getFingerprint();
        console.log("fingerprint:" + inspect(finger));
        let cipher = crypto.createCipher('aes192', finger);
        let encrypted_exp = cipher.update(JSON.stringify(count), 'utf8', 'hex');
        encrypted_exp += cipher.final('hex');

        let backup_loc = path.join(`/tmp`, finger, `.${finger}1`);

        await fs.writeFile(loc, encrypted_exp, {encoding: 'utf8', mode: terms.HDB_FILE_PERMISSIONS}).catch((err) => {
            log.error(`Error writing count file to ${loc}`);
            log.error(err);
            throw new Error('There was an error writing the count');
        });

        await fs.outputFile(backup_loc, encrypted_exp, {
            encoding: 'utf8',
            mode: terms.HDB_FILE_PERMISSIONS
        });
    } catch(err) {
        log.error('Error saving calls');
        log.error(err);
    }
}

module.exports = {
    saveApiCallCount
};

