const EventEmitter = require('events');

const EVENT_NAME = 'status';

class ClusterStatusEmitter extends EventEmitter {}

let clusterEmitter = new ClusterStatusEmitter();

module.exports = {
    clusterEmitter,
    EVENT_NAME
};