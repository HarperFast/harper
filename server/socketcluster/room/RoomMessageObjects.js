"use strict";

const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const uuid = require('uuid/v4');

/**
 * This collection of classes defines how messages should look when being passed around the various rooms.
 */

/**
 * Message superclass
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
 * A message sent to the worker room as a response to a GET_STATUS message.
 */
class WorkerStatusMessage {
  constructor() {
      this.owning_worker_id = undefined;
      this.type = types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS_RESPONSE;
      this.originator_msg_id = undefined;
      this.outbound_connections = [];
      this.inbound_connections = [];
  }
}

/**
 * A message sent when a worker is created or destroyed, used to track a worker list on each worker in the cluster.
 */
class WatchHdbWorkersMessage {
    constructor() {
        this.id = uuid();
        this.type = types.CORE_ROOM_MSG_TYPE_ENUM.HDB_WORKERS;
        this.workers = [];
    }
}

/**
 * A message sent to sync users between HDB Core and socket cluster workers.
 */
class SyncHdbUsersMessage {
    constructor() {
        this.id = uuid();
        this.type = types.CORE_ROOM_MSG_TYPE_ENUM.HDB_USERS_MSG;
        this.users = {};
    }
}

/**
 * A message sent by 1 worker to the worker room meant to ask other workers to post their connection status.
 */
class GetClusterStatusMessage {
    constructor() {
        this.type = types.WORKER_ROOM_MSG_TYPE_ENUM.GET_STATUS;
        this.request_id = uuid();
        this.requestor_channel = undefined;
        this.worker_request_owner_id = undefined;
        this.originator_msg_id = undefined;
    }
}

/**
 * A message sent from an HDB Child to an SC worker to get connection status for the cluster.
 */
class HdbCoreClusterStatusRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS);
        this.requesting_hdb_worker_id = undefined;
        this.requestor_channel = undefined;
    }
}

/**
 * A message sent from an SC Worker to and HDB Child which contains the connection status for all workers in the cluster.
 */
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

/**
 * A message that is sent by an HDB Child when a user is added to HDB Core
 */
class HdbCoreClusterAddUserRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ADD_USER);
        this.user = undefined;
    }
}

/**
 * A message that is sent by an HDB Child when a user is altered in HDB Core
 */
class HdbCoreClusterAlterUserRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ALTER_USER);
        this.user = undefined;
    }
}

/**
 * A message that is sent by an HDB Child when a user is dropped in HDB Core
 */
class HdbCoreClusterDropUserRequestMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.DROP_USER);
        this.user = undefined;
    }
}

/**
 * A message sent to or from socket cluster which contains an operation that happened in the database that needs to be
 * replicated.
 */
class HdbCoreOperationMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.HDB_OPERATION);
        this.operation = undefined;
    }
}

/**
 * A message that is sent by an HDB Child when a node is added in HDB Core
 */
class HdbCoreAddNodeMessage extends HdbCoreBaseMessageIF {
    constructor() {
        super(types.CORE_ROOM_MSG_TYPE_ENUM.ADD_NODE);
        this.node = undefined;
    }
}

/**
 * A message that is sent by an HDB Child when a node is removed in HDB Core
 */
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
    SyncHdbUsersMessage
};