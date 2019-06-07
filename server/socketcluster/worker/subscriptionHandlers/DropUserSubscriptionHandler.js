"use strict";

const SubscriptionHandlerIF = require('./SubscriptionHandlerIF');
const types = require('../../clusterTypes');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const {inspect} = require('util');

class DropUserSubscriptionHandler extends SubscriptionHandlerIF {
    constructor(worker) {
        super(worker, types.INTERNAL_SC_CHANNELS.DROP_USER);
    }

    async handler(user, response) {
        try {
            if (this.worker.hdb_users[user.username] !== undefined) {
                delete this.hdb_users[user.username];

                await this.exchange_set(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, this.worker.hdb_users);
                this.worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, this.worker.hdb_users);
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = DropUserSubscriptionHandler;