"use strict";

const License = require('../registration/licenseObjects').ExtendedLicense;
const terms = require('../hdbTerms');

class LicenseManager{
    constructor(){
        if(process.env[terms.HDB_LICENCE_NAME] !== undefined){
            this.license = process.env[terms.HDB_LICENCE_NAME];
        } else {
            this.license = new License();
        }
    }
}

module.exports = new LicenseManager();