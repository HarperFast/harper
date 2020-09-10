'use strict';

const env = require('../../utility/environment/environmentManager');
env.initSync();
const fs = require('fs-extra');
const path = require('path');
const terms = require('../../utility/hdbTerms');
const crypto = require('crypto');
const uuid = require('uuid/v4');

module.exports = checkJWTTokenExist;
/**
 * checks that the RSA keys exist for JWT generation, if not we create them
 */
function checkJWTTokenExist(){
    if(env.getHdbBasePath() !== undefined){
        //check that key files exist
        let private_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_PRIVATE_KEY_NAME);
        let public_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_PUBLIC_KEY_NAME);

        try {
            fs.accessSync(private_key_path);
            fs.accessSync(public_key_path);
        }catch(e){
            //if either one of the files does not exist we need regenerate both
            if(e.code === 'ENOENT'){
                //based on https://nodejs.org/docs/latest-v12.x/api/crypto.html#crypto_crypto_generatekeypairsync_type_options
                let key_pair = crypto.generateKeyPairSync('rsa', {
                    modulusLength: 4096,
                    publicKeyEncoding: {
                        type: 'spki',
                        format: 'pem'
                    },
                    privateKeyEncoding: {
                        type: 'pkcs8',
                        format: 'pem',
                        cipher: 'aes-256-cbc',
                        passphrase: uuid()
                    }
                });

                fs.writeFileSync(private_key_path, key_pair.privateKey);
                fs.writeFileSync(public_key_path, key_pair.publicKey);
            }else {
                throw e;
            }
        }
    }
}