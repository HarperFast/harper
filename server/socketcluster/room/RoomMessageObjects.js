"use strict";

const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const uuid = require('uuid/v4');

class HdbCoreMessageIF {
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
        this.data.type = types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS;
        this.data.request_id = uuid();
        this.data.requestor_channel = undefined;
        this.data.worker_request_owner_id = undefined;
        this.data.originator_msg_id = undefined;
    }
}

class HdbCoreClusterStatusRequestMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS);
        this.data = {};
        this.data.requesting_hdb_worker_id = undefined;
        this.data.requestor_channel = undefined;
    }
}

class HdbCoreClusterStatusResponseMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE);
        this.data.owning_worker_id = undefined;
        this.data.cluster_status_request_id = undefined;
        this.data.outbound_connections = [];
        this.data.inbound_connections = [];
        this.data.error = undefined;
    }
}

class HdbCoreClusterAddUserRequestMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ADD_USER);
        this.data.user = undefined;
    }
}

class HdbCoreClusterAlterUserRequestMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ALTER_USER);
        this.data.user = undefined;
    }
}

class HdbCoreClusterDropUserRequestMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.DROP_USER);
        this.data.user = undefined;
    }
}

class HdbCoreOperationMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.HDB_OPERATION);
        this.data.operation = undefined;
    }
}

class HdbCoreAddNodeMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ADD_NODE);
        this.data.node = undefined;
    }
}

class HdbCoreRemoveNodeMessage extends HdbCoreMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.REMOVE_NODE);
        this.data.node = undefined;
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