const EventEmitter = require('events');

const EVENT_NAME = 'sio_server_stopped';

class SioServerStoppedEventEmitter extends EventEmitter {}

let sioServerStoppedEmitter = new SioServerStoppedEventEmitter();

class SioServerStoppedMessage {
    constructor() {

    }
}

module.exports = {
    sioServerStoppedEmitter,
    SioServerStoppedMessage,
    EVENT_NAME
};