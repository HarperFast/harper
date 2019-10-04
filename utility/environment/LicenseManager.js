"use strict";

const License = require('../registration/licenseObjects').ExtendedLicense;
const terms = require('../hdbTerms');
const log = require('../logging/harper_logger');
const hdb_license = require('../registration/hdb_license');

class LicenseManager{
    constructor(){
        try {
            this.license = hdb_license.licenseSearch();
        } catch(e){
            log.error(`invalid license JSON object ${process.env[terms.HDB_LICENSE_NAME]}, failed to parse due to: ${e.message}`);
            this.license = new License();
        }
    }
}

module.exports = new LicenseManager();