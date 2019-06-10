"use strict";

const SubscriptionHandlerIF = require('./SubscriptionHandlerIF');
const types = require('../../types');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const {inspect} = require('util');

class AlterUserSubscriptionHandler extends SubscriptionHandlerIF {
    constructor(worker) {
        super(worker, hdb_terms.INTERNAL_SC_CHANNELS.ALTER_USER);
    }

    async handler(user, response) {
        log.trace('AlterUserSubscriptionHandler handler');
        try {
            let current_user = this.hdb_users[user.username];
            if (current_user !== undefined) {
                Object.keys(user).forEach((attribute)=>{
                    current_user[attribute] = user[attribute];
                });

                this.hdb_users[user.username] = current_user;

                await this.exchange_set(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, this.hdb_users);
                this.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, this.hdb_users);
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = AlterUserSubscriptionHandler;