"use strict";

const SubscriptionHandlerIF = require('./SubscriptionHandlerIF');
const types = require('../../types');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const {inspect} = require('util');

class WatchUsersSubscriptionHandler extends SubscriptionHandlerIF {
    constructor(worker) {
        super(worker, hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS);
    }

    async handler(users, response) {
        try {
            log.trace('WatchUserSubscriptionHandler handler');
            if(users && typeof users === 'object') {
                this.worker.hdb_users = users;
            } else {
                this.worker.hdb_users = {};
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = WatchUsersSubscriptionHandler;