"use strict";

const helium_utils = require('../helium/heliumUtils');
const migrator = require('../helium/dataMigrator');

let helium = helium_utils.initializeHelium();
helium_utils.createSystemDataStores(helium);

migrator();