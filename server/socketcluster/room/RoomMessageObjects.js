"use strict";

const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const uuid = require('uuid/v4');

class WorkerStatusMessage {
  constructor() {
      this.data = {};
      this.data.owning_worker_id = undefined;
      this.data.type = types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS_RESPONSE;
      this.data.originator_msg_id = undefined;
      this.data.outbound_connections = [];
      this.data.inbound_connections = [];
  }
}

class ErrorResponseMessage {
    constructor() {
        this.data = {};
        this.data.owning_worker_id = undefined;
        this.data.type = types.CORE_ROOM_MSG_TYPE_ENUM.ERROR_RESPONSE;
        this.data.error = undefined;
    }
}

class GetClusterStatusMessage {
    constructor() {
        this.data = {};
        this.data.type = types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS;
        this.data.request_id = uuid();
        this.data.requestor_channel = undefined;
        this.data.worker_request_owner_id = undefined;
        this.data.originator_msg_id = undefined;
    }
}

class HdbCoreClusterStatusRequestMessage {
    constructor() {
        this.data = {};
        this.data.type = types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS;
        this.data.requesting_hdb_worker_id = undefined;
        this.data.requestor_channel = undefined;
        this.data.hdb_header = {};
    }
}

class HdbCoreClusterStatusResponseMessage {
    constructor() {
        this.data = {};
        this.data.type = types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE;
        this.data.owning_worker_id = undefined;
        this.data.cluster_status_request_id = undefined;
        this.data.outbound_connections = [];
        this.data.inbound_connections = [];
        this.data.error = undefined;
    }
}

module.exports = {
    GetClusterStatusMessage,
    WorkerStatusMessage,
    HdbCoreClusterStatusRequestMessage,
    HdbCoreClusterStatusResponseMessage,
    ErrorResponseMessage
};