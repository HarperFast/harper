"use strict"

/**
 * This class defines the data types used to create the necessary items for an install or upgrade.
 */

/**
 * Class that describes how an environment variable should be written to the settings.js file.
 */
class environmentVariable {
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
    }
}

/**
 * Class that describes the data required for an install or upgrade.
 */
class installDirective {
    /**
     * Constructor for an installDirective.
     * @param version_number - The version of HDB this directive describes.
     */
    constructor(version_number) {
        this.version = version_number;
        // paths relative to HDB_ROOT that need to be created can be added into this.
        this.schema_relative_paths = [];
        // Any environment variables which need to be created can be added into here.  Each should be of type
        // environmentVaraible
        this.environment_variables = [];
        // Functions can be added into this which will be run after the paths are created.
        this.functions = [];
    }
}

module.exports = {
    installDirective:installDirective,
    environmentVariable:environmentVariable
}