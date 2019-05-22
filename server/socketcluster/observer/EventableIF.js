"use strict";

/**
 * Eventable was meant to be used as an observer type pattern, but ended up being removed along with the messageQueue.
 * At some point we will probably need to use observer, likely via eventing, so this is left as a placeholder.
 */

class EventableIF {
    constructor() {

    }

    /**
     * Notify all observers that something has happened.
     * @param content
     */
    notify(content) {
        throw new Error('Not implemented');
    }

    /**
     * This may not be implmentable depending on the technology used in the subclass.
     * @param messageIF_object
     */
    onMessage(messageIF_object) {
        throw new Error('Not Implemented');
    }

    emit(topic, messageIf_object) {
        throw new Error('Not Implemented');
    }
}

module.exports = EventableIF;