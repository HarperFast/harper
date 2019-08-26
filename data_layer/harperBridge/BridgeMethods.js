"use strict";

/**
 * BridgeMethods Class provides a framework for all HarperBridge method classes
 */

class BridgeMethods {
    createSchema() {
        throw new Error("createSchema bridge method is not defined");
    }

    dropSchema() {
        throw new Error("dropSchema bridge method is not defined");
    }

    createTable() {
        throw new Error("createTable bridge method is not defined");
    }

    dropTable() {
        throw new Error("dropTable bridge method is not defined");
    }

    createRecords() {
        throw new Error("createRecords bridge method is not defined");
    }

    updateRecords() {
        throw new Error("updateRecords bridge method is not defined");
    }

    deleteRecords() {
        throw new Error("deleteRecords bridge method is not defined");
    }

    createAttribute() {
        throw new Error("createAttribute bridge method is not defined");
    }

    dropAttribute() {
        throw new Error("dropAttribute bridge method is not defined");
    }

    searchByHash() {
        throw new Error("searchByHash bridge method is not defined");
    }

    searchByValue() {
        throw new Error("searchByValue bridge method is not defined");
    }

    getDataByHash() {
        throw new Error("getDataByHash bridge method is not defined");
    }

    getDataByValue() {
        throw new Error("getDataByValue bridge method is not defined");
    }

    deleteRecordsBefore() {
        throw new Error("deleteRecordsBefore bridge method is not defined");
    }
}

module.exports = BridgeMethods;