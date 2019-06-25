const EventEmitter = require('events');

const EVENT_NAME = 'socketClusterStatus';

class SocketClusterStatusEmitter extends EventEmitter {}

let socketClusterEmitter = new SocketClusterStatusEmitter();

module.exports = {
    socketClusterEmitter,
    EVENT_NAME,
    SocketClusterStatusEmitter
};