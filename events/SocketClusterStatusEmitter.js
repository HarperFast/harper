const EventEmitter = require('events');

const EVENT_NAME = 'status';

class SocketClusterStatusEmitter extends EventEmitter {}

let socketClusterEmitter = new SocketClusterStatusEmitter();

module.exports = {
    clusterEmitter: socketClusterEmitter,
    EVENT_NAME,
    ClusterStatusEmitter: SocketClusterStatusEmitter
};