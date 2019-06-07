"use strict";

/**
 * A factory module for creating middleware.  Will construct and return a middlewareIF object based on the options
 * parameter.
 * @type {MiddlewareIF}
 */

const types = require('../types');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');

// handler imports
const WorkerRoomSubscriptionHandler = require('../subscriptionHandlers/WorkerRoomSubscriptionHandler');
const AddUserSubscriptionHandler = require('../subscriptionHandlers/AddUserSubscriptionHandler');
const DropUserSubscriptionHandler = require('../subscriptionHandlers/DropUserSubscriptionHandler');
const AlterUserSubscriptionHandler = require('../subscriptionHandlers/AlterUserSubscriptionHandler');
const WatchUsersSubscriptionHandler = require('../subscriptionHandlers/WatchUsersSubscriptionHandler');
const WatchWorkersSubscriptionHandler = require('../subscriptionHandlers/WatchWorkersSubscriptionHandler');

/**
 * A
 * @param subscription_topic_name
 * @param eval_function
 * @param options
 * @returns {null}
 */
function createSubscriptionHandler(subscription_topic_name, worker) {
    let created_subscription_handler = null;
    try {
        switch(subscription_topic_name) {
            case hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM:
                log.trace('Creating Worker Room Subscription Handler');
                created_subscription_handler = new WorkerRoomSubscriptionHandler(worker);
                break;
            case hdb_terms.INTERNAL_SC_CHANNELS.ADD_USER:
                log.trace('Creating Add User Subscription Handler');
                created_subscription_handler = new AddUserSubscriptionHandler(worker);
                break;
            case hdb_terms.INTERNAL_SC_CHANNELS.DROP_USER:
                log.trace('Creating Add User Subscription Handler');
                created_subscription_handler = new DropUserSubscriptionHandler(worker);
                break;
            case hdb_terms.INTERNAL_SC_CHANNELS.ALTER_USER:
                log.trace('Creating Add User Subscription Handler');
                created_subscription_handler = new AlterUserSubscriptionHandler(worker);
                break;
            case hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS:
                log.trace('Creating Add Watch Users Subscription Handler');
                created_subscription_handler = new WatchUsersSubscriptionHandler(worker);
                break;
            case hdb_terms.INTERNAL_SC_CHANNELS.HDB_WORKERS:
                log.trace('Creating Add Watch Users Subscription Handler');
                created_subscription_handler = new WatchWorkersSubscriptionHandler(worker);
                break;
            default:
                break;
        }
    } catch(err) {
        log.error(`In createMiddleware: ${err}`);
    }
    return created_subscription_handler;
}

module.exports = {
    createSubscriptionHandler,
};
