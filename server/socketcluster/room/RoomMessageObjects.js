"use strict";

const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const uuid = require('uuid/v4');

/**
    Messages sent through a socket automatically have the contained values put into the .data field by the exchange
    itself, so we don't create a data field like we do in RoomMessageBaseIF.
 */
class HdbCoreBaseMessageIF {
    constructor(core_room_msg_type_enum) {
        this.id = uuid();
        this.type = core_room_msg_type_enum;
        this.hdb_header = {};
        this.operation = undefined;
    }
}

/**
 * Messages not sent through a socket do not have the .data field created, so in order to create parity with socket messages,
 * we create a .data field.
 */
class IntraRoomMessageBaseIF {
    constructor(core_room_msg_type_enum) {
        this.data = {};
        this.data.id = uuid();
        this.data.type = core_room_msg_type_enum;
        this.data.hdb_header = {};
        this.data.operation = undefined;
    }
}

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

class WatchHdbWorkersMessage {
    constructor() {
        this.data = {};
        this.data.id = uuid();
        this.data.type = types.CORE_ROOM_MSG_TYPE_ENUM.HDB_WORKERS;
        this.data.workers = [];
    }
}

class SyncHdbUsersMessage {
    constructor() {
        this.data = {};
        this.data.id = uuid();
        this.data.type = types.CORE_ROOM_MSG_TYPE_ENUM.HDB_USERS_MSG;
        this.data.users = {};
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
        this.data.type = types.WORKER_ROOM_MSG_TYPE_ENUM.GET_STATUS;
        this.data.request_id = uuid();
        this.data.requestor_channel = undefined;
        this.data.worker_request_owner_id = undefined;
        this.data.originator_msg_id = undefined;
    }
}

class HdbCoreClusterStatusRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS);
        this.requesting_hdb_worker_id = undefined;
        this.requestor_channel = undefined;
    }
}

class HdbCoreClusterStatusResponseMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE);
        this.owning_worker_id = undefined;
        this.cluster_status_request_id = undefined;
        this.outbound_connections = [];
        this.inbound_connections = [];
        this.error = undefined;
    }
}

class HdbCoreClusterAddUserRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ADD_USER);
        this.user = undefined;
    }
}

class HdbCoreClusterAlterUserRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ALTER_USER);
        this.user = undefined;
    }
}

class HdbCoreClusterDropUserRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.DROP_USER);
        this.user = undefined;
    }
}

class HdbCoreOperationMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.HDB_OPERATION);
        this.operation = undefined;
    }
}

class HdbCoreAddNodeMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ADD_NODE);
        this.node = undefined;
    }
}

class HdbCoreRemoveNodeMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.REMOVE_NODE);
        this.node = undefined;
    }
}

module.exports = {
    GetClusterStatusMessage,
    WorkerStatusMessage,
    WatchHdbWorkersMessage,
    HdbCoreClusterStatusRequestMessage,
    HdbCoreClusterStatusResponseMessage,
    HdbCoreClusterAddUserRequestMessage,
    HdbCoreClusterAlterUserRequestMessage,
    HdbCoreClusterDropUserRequestMessage,
    HdbCoreOperationMessage,
    HdbCoreAddNodeMessage,
    HdbCoreRemoveNodeMessage,
    SyncHdbUsersMessage,
    ErrorResponseMessage
};