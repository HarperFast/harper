const EventEmitter = require('events');

const EVENT_NAME = 'all_children_stopped';

class AllChildrenStoppedEventEmitter extends EventEmitter {}

let allChildrenStoppedEmitter = new AllChildrenStoppedEventEmitter();

class AllChildrenStoppedMessage {
    constructor() {

    }
}

module.exports = {
    allChildrenStoppedEmitter,
    AllChildrenStoppedMessage,
    EVENT_NAME
};