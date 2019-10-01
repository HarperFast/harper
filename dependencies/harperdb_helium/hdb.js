"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
require('module-alias/register');
var testUtils_1 = __importDefault(require("./test/testUtils"));
var os = __importStar(require("os"));
var path = __importStar(require("path"));
var moduleName = "node-hdb.node";
var buildPath = '';
if (os.platform() === 'darwin') {
    buildPath = 'mac/build';
}
else {
    buildPath = 'build';
}
var modulePath = path.join(__dirname, buildPath, testUtils_1.default.MODE, moduleName);
var HDBjs = require(modulePath);
function printStr(str, padding, EOF) {
    if (EOF === void 0) { EOF = false; }
    if (str !== undefined && str.length > 50) {
        var index = 50;
        while (index < str.length) {
            if (str[index] === " ")
                break;
            index++;
        }
        console.debug(" ".repeat(4) + "│" + " ".repeat(padding) + ("" + str.slice(0, index)));
        printStr(str.slice(index), padding, EOF);
    }
    else {
        if (EOF) {
            console.debug(" ".repeat(4) + "│" + " ".repeat(padding) + ("" + str));
        }
        else
            console.debug(" ".repeat(4) + "│" + " ".repeat(padding) + (str + ","));
    }
}
function printArray(args, offset) {
    if (offset === void 0) { offset = 1; }
    args.forEach(function (arg, i) {
        if (!Array.isArray(arg) || arg.length === 0) {
            if (i !== args.length - 1)
                printStr(JSON.stringify(arg), offset * 4 + 1);
            else
                printStr(JSON.stringify(arg), offset * 4 + 1, true);
        }
        else {
            console.debug(" ".repeat(4) + "│" + " ".repeat(offset * 4 + 1) + "[");
            printArray(arg, offset + 1);
            console.debug(" ".repeat(4) + "│" + " ".repeat(offset * 4 + 1) + "],");
        }
    });
}
function debug(target, propertyName, propertyDesciptor) {
    var method = propertyDesciptor.value;
    propertyDesciptor.value = function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        if (this.DEBUG) {
            var params = args.map(function (a) { return JSON.stringify(a); }).join();
            console.debug("Calling function " + propertyName + "(...)");
            if (!Array.isArray(args) || args.length === 1 && !Array.isArray(args[0])) {
                console.debug(" ".repeat(4) + ("\u251C\u2500\u2500Arg: " + params));
            }
            else {
                args.forEach(function (arg, i) {
                    if (!Array.isArray(arg) || arg.length === 0) {
                        console.debug(" ".repeat(4) + ("\u251C\u2500\u2500Arg[" + i + "]: " + JSON.stringify(arg)));
                    }
                    else {
                        console.debug(" ".repeat(4) + ("\u251C\u2500\u2500Arg[" + i + "]: ["));
                        printArray(arg);
                        console.debug(" ".repeat(4) + "├" + " ".repeat(3) + "]");
                    }
                });
            }
        }
        var ret = method.apply(this, args);
        var r = JSON.stringify(ret);
        if (this.DEBUG) {
            if (!Array.isArray(ret) || ret.length === 1 && !Array.isArray(ret[0])) {
                console.debug(" ".repeat(4) + ("\u2514\u2500\u2500Return: " + r));
            }
            else {
                ret.forEach(function (ret_val, i) {
                    if (!Array.isArray(ret_val) || ret_val.length === 0) {
                        if (i !== ret.length - 1)
                            console.debug(" ".repeat(4) + ("\u251C\u2500\u2500Return[" + i + "]: " + JSON.stringify(ret_val)));
                        else
                            console.debug(" ".repeat(4) + ("\u2514\u2500\u2500Return[" + i + "]: " + JSON.stringify(ret_val)));
                    }
                    else {
                        console.debug(" ".repeat(4) + ("\u251C\u2500\u2500Return[" + i + "]: ["));
                        printArray(ret_val);
                        if (i !== ret.length - 1)
                            console.debug(" ".repeat(4) + "├" + " ".repeat(3) + "]");
                        else
                            console.debug(" ".repeat(4) + "└" + " ".repeat(3) + "]");
                    }
                });
            }
        }
        return ret;
    };
    return propertyDesciptor;
}
exports.debug = debug;
;
var HDB = /** @class */ (function () {
    function HDB(DEBUG) {
        if (DEBUG === void 0) { DEBUG = false; }
        this.DEBUG = DEBUG;
    }
    /** openSession
     *      A function to create a session with a helium server/volume. This session
     *      should be closed before termination of the client.

     *  @param {string} heliumURL - A helium URL in the format he://<hostname>//<volume>
     *  @return 		          - Helium error message.
     */
    HDB.prototype.startSession = function (heliumURL) {
        var ret = HDBjs.startSession(heliumURL);
        return ret;
    };
    HDB.prototype.stopSession = function (heliumURL) {
        var ret = HDBjs.stopSession(heliumURL);
        return ret;
    };
    /** function insertRows
     *      A function to insert rows into multiple datastores concurrently. If the
     *      item exists, it should indicate in return that it already existed.
     *  @param dataStores - An array of string that list all of the datastores being
                             written to. The order of the datastores will match the order
                             of the data sent in the parameter dataRows.
     *  @param dataRows   - A multi-dimensional string array containing the data to be inserted.
     *  @return 		  - A multi-dimensional array representing the primary keys of the rows
                             that were inserted and the primary keys of the rows that were
                             skipped due to already existing.
     */
    HDB.prototype.insertRows = function (dataStores, dataRows) {
        var ret = HDBjs.insertRows(dataStores, dataRows);
        return ret;
    };
    /** function updateRows
            A function to update the rows of multiple datastores concurrently. If an
            element did not exist, skip? TODO clarify this
        @param dataStores - An array of string that list all of the datastores being
                             written to. The order of the datastores will match the order
                             of the data sent in the parameter dataRows.
        @param dataRows  - A multi-dimensional string array containing the data to be updated.
        @return          - A multi-dimensional array representing the primary keys of the rows
                            that were updated and the primary keys of the rows that were
                            skipped due to not existing.
    */
    HDB.prototype.updateRows = function (dataStores, dataRows) {
        var ret = HDBjs.updateRows(dataStores, dataRows);
        return ret;
    };
    /** function deleteRows
            A function to delete multiple values from multiple datastores concurrently.
            If the row does not exist, skip it.
    
        @param dataStores - An array of string that list all of the datastores being
                            deleted.
        @param keys		  - An array of primary keys to be deleted.
        @return           - A multi-dimensional array representing the primary keys of the rows
                            that were deleted and the primary keys of the rows that were
                            skipped due to not existing. Array in index 0 represents items
                            deleted, the array in index 1 represents items that were skipped.
    */
    HDB.prototype.deleteRows = function (dataStores, keys) {
        var ret = HDBjs.deleteRows(dataStores, keys);
        return ret;
    };
    /** function searchByKeys
        The purpose of this API is to return multiple key/values across multiple data stores.
        The API will receive a array list of datastores to search upon and the keys to search.
        The API will return a multi-dimensional array of key values, where each array is the
        returned results from each datastore.

    @param keys		  - An array of keys to be searched from the listed datastores
    @param dataStores - An array of strings that list all of the datastores to be searched.
    @return 		  - A multidimensional array which contains the key/value entries
                        for each datastore, matching the order of the passed in data
                        stores.
    */
    HDB.prototype.searchByKeys = function (keys, dataStores) {
        var ret = HDBjs.searchByKeys(keys, dataStores);
        return ret;
    };
    /** function searchByValues
        The purpose of this API is to return multiple key/values across multiple data stores.
        The API will receive a datastore whose values is to be searched, type of operation to perform
        and an array of datastore whose corresponding values to be returned.

    @param valueStore - Datastore containing the values to be searched.
    @param operation  - This is the type of the comparison operation to be performed.
                        Valid comparison operations are:
                        + “exact” - Default. Exact comparison. The value must match completely
                        + “startsWith” - the actual value must begin with the specified value.
                        + “endsWith” - the actual value must end with the specified value.
                        + “includes” - the actual value must contain the specified value at any position.
                        + “exactNoCase” - case insensitive version of “exact”.
                        + “startsWithNoCase” - case insensitive version of “startsWith”.
                        + “endsWithNoCase” - case insensitive version of “endsWith”.
                        + “includesNoCase” - case insensitive version of “includes”.
    @param values     - Array of strings that lists all the values to be searched for.
    @param dataStores - An array of strings that list all of the datastores whose values are to be returned.
    @return           - A multidimensional array which contains the key/value entries
                        for each datastore, matching the order of the passed in data
                        stores.
    */
    HDB.prototype.searchByValues = function (valueStore, operation, values, dataStores) {
        var ret = HDBjs.searchByValues(valueStore, operation, values, dataStores);
        return ret;
    };
    /** function searchByValueRange
        The purpose of this API is to return multiple key/values across multiple data stores
        based on a single string comparison range.
        The API will receive a array list of datastores to search upon and the keys to search.
        The API will return a multi-dimensional array of values, where each array is
        the returned results from each of the output datastores.

    @param valueStore     - Datastore containing the values to be evaluated.
    @param rangeOperation - This is the type of the range operation to be performed.
                            Valid range operations are:
                            + "<" - smaller than
                            + "<=" - smaller than or equal
                            + ">" - greater than
                            + ">=" - greater than or equal
                            + "==" - equal
                            + "!=" - not equal
                            + "()" - ranged query, not including the upper and lower limits
                            + "[)" - ranged query that includes the lower limit
                            + "(]" - ranged query that includes the upper limit
                            + "[]" - ranged query that includes both the lower and the upper limits
    @param arg            - The first comparison value. It cannot be null nor undefined.
                            This is also the lowerLimit for the ranged queries
    @param upperLimit     - Upper limit for the range queries.
                            It must be null or undefined for the non ranged queries.
    @param dataStores     - An array of strings that list all of the datastores whose values are to be returned.
    @return               - Return a multi-dimensional array which contains the value entries for each data store,
                            followed by an array containing the corresponding values from the output data stores.
                            The order of the returned results is undefined.
    */
    HDB.prototype.searchByValueRange = function (valueStore, rangeOperation, arg, upperLimit, dataStores) {
        var ret = HDBjs.searchByValueRange(valueStore, rangeOperation, arg, upperLimit, dataStores);
        return ret;
    };
    /** function listDataStores
            The purpose of this API is to list datastores, the API will receive an optional
            regex to allow for searching for specific datastores.
        @param regex (optional) - If no regex is supplied then return all items, otherwise
                                   return items which match.
        @return 				- A String array of values which match the regex (if specified).
                                   If no regex is specified, list all datastores associated with
                                   this session.
    */
    HDB.prototype.listDataStores = function (regex) {
        var ret;
        if (regex !== undefined) {
            ret = HDBjs.listDataStores(regex);
        }
        else {
            ret = HDBjs.listDataStores();
        }
        return ret;
    };
    /** function createDataStores
        @param dataStores - String array of the list of datastore names to create.
        @return 		  - An array of helium errors, 0 indicating no error.
    */
    HDB.prototype.createDataStores = function (dataStores) {
        var ret = HDBjs.createDataStores(dataStores);
        return ret;
    };
    /** function renameDataStore
            The purpose of this API is to rename an existing datastore.
        @param dataStore - Name of an existing datastore to rename
        @param name 	 - New name of the datastore
        @return 		 - Return a Helium error if unable to rename
    */
    HDB.prototype.renameDataStore = function (dataStore, name) {
        var ret = HDBjs.renameDataStore(dataStore, name);
        return ret;
    };
    /** function deleteDataStores
            The purpose of this API is delete multiple datastores concurrently.
        @param dataStores - String array of datastores to be deleted from this session.
        @return			  - Return an error for datastores which could not be deleted, null
                             if no error.
    */
    HDB.prototype.deleteDataStores = function (dataStores) {
        var ret = HDBjs.deleteDataStores(dataStores);
        return ret;
    };
    /** function stats
            The purpose of this API is to return stats for multiple datastores.
        @param dataStores - String array of the datastore whose stats to return.
        @return			  - A multi-dimensional array of the helium stats for the datastores
                             requested, or an error if some occured.
    */
    HDB.prototype.stats = function (dataStores) {
        var ret = HDBjs.stats(dataStores);
        return ret;
    };
    __decorate([
        debug
    ], HDB.prototype, "startSession", null);
    __decorate([
        debug
    ], HDB.prototype, "stopSession", null);
    __decorate([
        debug
    ], HDB.prototype, "insertRows", null);
    __decorate([
        debug
    ], HDB.prototype, "updateRows", null);
    __decorate([
        debug
    ], HDB.prototype, "deleteRows", null);
    __decorate([
        debug
    ], HDB.prototype, "searchByKeys", null);
    __decorate([
        debug
    ], HDB.prototype, "searchByValues", null);
    __decorate([
        debug
    ], HDB.prototype, "searchByValueRange", null);
    __decorate([
        debug
    ], HDB.prototype, "listDataStores", null);
    __decorate([
        debug
    ], HDB.prototype, "createDataStores", null);
    __decorate([
        debug
    ], HDB.prototype, "renameDataStore", null);
    __decorate([
        debug
    ], HDB.prototype, "deleteDataStores", null);
    __decorate([
        debug
    ], HDB.prototype, "stats", null);
    return HDB;
}());
exports.default = HDB;
//# sourceMappingURL=hdb.js.map