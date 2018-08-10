"use strict";
/**
 * Class that describes the data required for an install or upgrade.
 */
class UpgradeDirective {
    /**
     * Constructor for an upgradeDirective.
     * @param version_number - The version of HDB this directive describes.
     */
    constructor(version_number) {
        this.version = version_number;
        // paths relative to HDB_ROOT that need to be created can be added into this.
        this.relative_directory_paths = [];
        // Any environment variables which need to be created can be added into here.  Each should be of type
        // environmentVaraible
        this.environment_variables = [];
        // Any environment variables which need to be removed from the existing file.  Each should be of type
        // environmentVaraible
        this.environment_variables_to_remove = [];
        // Functions can be added into this which will be run after the paths are created.  Functions must be
        // synchronous.
        this.functions = [];
        // Schemas to create.  TODO: Define this as a data type?
        this.schemas = [];
    }
}

module.exports = UpgradeDirective;
