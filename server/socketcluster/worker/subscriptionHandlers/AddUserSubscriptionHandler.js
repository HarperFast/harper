"use strict";

const SubscriptionHandlerIF = require('./SubscriptionHandlerIF');
const types = require('../../types');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const {inspect} = require('util');

class AddUserSubscriptionHandler extends SubscriptionHandlerIF {
    constructor(worker) {
        super(worker, hdb_terms.INTERNAL_SC_CHANNELS.ADD_USER);
    }

    async handler(user, response) {
        try {
            log.trace('AddUserSubscriptionHandler handler');
            if (this.hdb_users[user.username] === undefined) {
                this.hdb_users[user.username] = user;

                await this.exchange_set(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, this.hdb_users);
                this.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, this.hdb_users);
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = AddUserSubscriptionHandler;