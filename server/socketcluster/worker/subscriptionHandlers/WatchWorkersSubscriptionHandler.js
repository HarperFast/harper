"use strict";

const SubscriptionHandlerIF = require('./SubscriptionHandlerIF');
const types = require('../../types');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const {inspect} = require('util');

class WatchWorkersSubscriptionHandler extends SubscriptionHandlerIF {
    constructor(worker) {
        super(worker, hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS);
    }

    async handler(workers, response) {
        log.trace('WatchWorkersSubscriptionHandler handler');
        try {
            if(workers && Array.isArray(workers)) {
                this.hdb_workers = workers;
            } else {
                this.hdb_workers = [];
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = WatchWorkersSubscriptionHandler;