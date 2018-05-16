"use strict";

/**
 * Class that describes how an environment variable should be written to the settings.js file.
 */
class EnvironmentVariable {
    /**
     * Constructor
     * @param variable_name - Variable name as it should appear in the settings.js file (e.x. SERVER_TIMEOUT_MS).
     * @param default_value - Value that will be assigned the variable in the settings.js file (e.x. 120000);
     * @param comments -  Comments that will be added to the settings.js file.  Each string in the array should
     * be an individual comment.  Each string will be prefixed with a ';', which is a .ini file
     * directory denoting a comment.  Each string in the array will have a newline character appended.
     */
    constructor(variable_name, default_value, comments) {
        // Variable name as it should appear in the settings.js file (e.x. SERVER_TIMEOUT_MS).
        this.name = variable_name;
        // Value that will be assigned the variable in the settings.js file (e.x. 120000);
        this.value = default_value;
        // Comments that will be added to the settings.js file.  Each string in the array should
        // be an individual comment.  Each string will be prefixed with a ';', which is a .ini file
        // directory denoting a comment.  Each string in the array will have a newline character appended.
        this.comments = comments;
        // This should be manually set to true if the value currently set in the settings file needs to be
        // updated to this value.
        this.force_value_update = false;
    }
}

module.exports = EnvironmentVariable;
