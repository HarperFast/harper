"use strict";

const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const uuid = require('uuid/v4');

class WorkerStatusMessage {
  constructor() {
      data: {
          this.owning_worker_id = undefined;
          this.type = types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS_RESPONSE;
          this.originator_msg_id = undefined;
          this.outbound_connections = [];
          this.inbound_connections = [];
      }
  }
}

class GetClusterStatusMessage {
    constructor() {
        data: {
            this.type = types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS;
            this.request_id = uuid();
            this.requestor_channel = undefined;
            this.worker_request_owner_id = undefined;
            this.originator_msg_id = undefined;
        }
    }
}

class HdbCoreClusterStatusRequestMessage {
    constructor() {
        data: {
            this.type = types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS;
            this.requesting_hdb_worker_id = undefined;
            this.requestor_channel = undefined;
            this.hdb_header = {};
        }
    }
}

class HdbCoreClusterStatusResponseMessage {
    constructor() {
        data: {
            this.type = types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE;
            this.responding_worker_id = undefined;
            this.cluster_status_request_id = undefined;
            this.outbound_connections = [];
            this.inbound_connections = [];
            this.error = undefined;
        }
    }
}

module.exports = {
    GetClusterStatusMessage,
    WorkerStatusMessage,
    HdbCoreClusterStatusRequestMessage,
    HdbCoreClusterStatusResponseMessage
};