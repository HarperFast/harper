"use strict";

class SubscriptionHandlerIF {
    constructor(worker, message_type) {
        this.topic = message_type;
        this.worker = worker;
    }

    async handler(input, respond) {
        throw new Error('Not Implemented');
    }
}

module.exports = SubscriptionHandlerIF;