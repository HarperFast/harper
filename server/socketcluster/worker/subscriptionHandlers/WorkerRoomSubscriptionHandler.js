"use strict";

const SubscriptionHandlerIF = require('./SubscriptionHandlerIF');
const types = require('../../clusterTypes');
const log = require('../../../../utility/logging/harper_logger');
const {inspect} = require('util');

class WorkerRoomSubscriptionHandler extends SubscriptionHandlerIF {
    constructor(worker) {
        super(worker, types.INTERNAL_SC_CHANNELS.WORKER_ROOM);
    }

    async handler(input, response) {
        console.log('Handling Room message: ' + inspect(input));
    }
}

module.exports = WorkerRoomSubscriptionHandler;