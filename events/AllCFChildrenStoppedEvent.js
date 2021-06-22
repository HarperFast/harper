const EventEmitter = require('events');

const EVENT_NAME = 'all_cf_children_stopped';

class AllCFChildrenStoppedEventEmitter extends EventEmitter {}

let allCFChildrenStoppedEmitter = new AllCFChildrenStoppedEventEmitter();

class AllCFChildrenStoppedMessage {
    constructor() {

    }
}

module.exports = {
    allCFChildrenStoppedEmitter,
    AllCFChildrenStoppedMessage,
    EVENT_NAME
};