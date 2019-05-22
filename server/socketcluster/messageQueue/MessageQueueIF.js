"use strict";

let queue = null;

/**
 * The message queue was part of the original design, but quickly phased out as it didn't add much but complexity.
 * At some point we may need to implement a message queue, so this is left as a placeholder.
 */

class MessageQueueIF {
    constructor() {
        this.eventable = null;
    }

    /**
     * Place a message in the queue
     * @param message_if
     */
    enqueueMessage(message_if) {
        throw new Error('Not implemented');
    }

    /**
     * Dequeue a message based on args
     * @returns MessageIF
     */
    dequeueMessage(GET_MSG_ARGS_enum) {
        throw new Error('Not implemented');
    }

    /**
     * Add an observer of this queue to be notified when the queue changes.
     * @param observerIF_object
     */
    setObservable(observerIF_object) {
        throw new Error('Not implemented');
    }
}

module.exports = MessageQueueIF;