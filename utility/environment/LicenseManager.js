"use strict";

const License = require('../registration/licenseObjects').ExtendedLicense;
const terms = require('../hdbTerms');
const log = require('../logging/harper_logger');

class LicenseManager{
    constructor(){
        if(process.env[terms.HDB_LICENSE_NAME] !== undefined){
            try {
                this.license = JSON.parse(process.env[terms.HDB_LICENSE_NAME]);
            } catch(e){
                log.error(`invalid license JSON object ${process.env[terms.HDB_LICENSE_NAME]}, failed to parse due to: ${e.message}`);
                this.license = new License();
            }
        } else {
            this.license = new License();
        }
    }
}

module.exports = new LicenseManager();