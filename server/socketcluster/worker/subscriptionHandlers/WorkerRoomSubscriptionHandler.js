"use strict";

const SubscriptionHandlerIF = require('./SubscriptionHandlerIF');
const types = require('../../types');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const {inspect} = require('util');

class WorkerRoomSubscriptionHandler extends SubscriptionHandlerIF {
    constructor(worker) {
        super(worker, hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM);
    }

    async handler(input, response) {
        log.trace('WorkerRoomSubscriptionHandler handler');
        console.log('Handling Room message: ' + inspect(input));
    }
}

module.exports = WorkerRoomSubscriptionHandler;