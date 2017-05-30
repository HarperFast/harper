const settings = require('../settings'),
    fs = require('fs'),
    password = require('./password'),
    crypto = require('crypto'),
    cipher = crypto.createCipher('aes192', 'a password'),
    decipher = crypto.createDecipher('aes192', 'a password'),
    validation = require('../validation/license_key_object.js'),
    moment = require('moment');



module.exports = {
    generateLicense: generateLicense,
    validateLicense: validateLicense,
    generateFingerPrint: generateFingerPrint
}



function generateFingerPrint(callback) {
    const uuidV4 = require('uuid/v4');
    var hash = uuidV4(); // -> '110ec58a-a0f2-4ac4-8393-c866d813b8d1'
    var hashed_hash = password.hash(hash)
    fs.writeFile(`${settings.PROJECT_DIR}/utility/keys/060493.ks`, hashed_hash, function (err, result) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, hashed_hash);
    })
}


function generateLicense(license_object, callback) {
    //
    let validation_error = validation(license_object);
    if(validation_error){
        callback(validation_error);
        return;
    }


    let fingerprint = license_object.fingerprint,
        company = license_object.company
    let encrypted_exp = hashDate(moment(license_object.exp_date).unix());


    console.log(encrypted_exp);
    let hash_license = hashLicense(fingerprint, company);

    let license = `${encrypted_exp}mofi25${hash_license}`
    console.log(license);
    callback(null, license);





}



function generateFingerPrint(callback) {
    const uuidV4 = require('uuid/v4');
    var hash = uuidV4(); // -> '110ec58a-a0f2-4ac4-8393-c866d813b8d1'
    var hashed_hash = password.hash(hash)
    fs.writeFile(`${settings.PROJECT_DIR}/utility/keys/060493.ks`, hashed_hash, function (err, result) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, hashed_hash);
    })
}




function validateLicense(license_key, company, callback) {
    var license_validation_object = {};
    var license_tokens = license_key.split('mofi25');
    license_validation_object.valid_date = true;
    license_validation_object.valid_license = true;
    license_validation_object.valid_machine = true;
    let decrypted = decipher.update(license_tokens[0], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    console.log(decrypted);

    var curDate = new Date();
    if (decrypted < moment().unix()) {
        license_validation_object.valid_date = false;

    }


    try {
        console.log(`${settings.PROJECT_DIR}/utility/keys/060493.ks`);

        fs.readFile(`${settings.PROJECT_DIR}/utility/keys/060493.ks`, function (err, data) {
            let fingerPrint = '' + data;
         //   var newHash = hashLicense(fingerPrint, company);
           // console.log(`new hash: ${newHash}`)
            if (password.validate(license_tokens[1], `061183${data}${company}`)) {
                license_validation_object.valid_license = false;

            }

            callback(license_validation_object);
            return;


        });
    } catch (e) {
        license_validation_object.valid_machine = false;
        callback(license_validation_object);
        return;
    }


}

function hashDate(expdate) {

    let encrypted_exp = cipher.update('' + expdate, 'utf8', 'hex');
    encrypted_exp += cipher.final('hex');
    return encrypted_exp;
}

function hashLicense(fingerprint, company) {
  //  let hmac = crypto.createHmac('sha256', 'a secret')
   // hmac.update(`061183${fingerprint}${company}`);
   // return hmac.digest('hex');
    return password.hash(`061183${fingerprint}${company}`);
}
