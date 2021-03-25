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
        this.change_description = "";
        // paths relative to HDB_ROOT that need to be created can be added into this.
        this.relative_directory_paths = [];
        // explicit paths that need to be created can be added into this.
        this.explicit_directory_paths = [];
        // Function that builds new settings file
        this.settings_file_function = undefined;
        // Functions can be added into this which will be run after the paths are created.  Functions must be
        // synchronous.
        this.functions = [];
        // Schemas to create.
        this.schemas = [];
        this.affected_file_paths = [];
    }
}

module.exports = UpgradeDirective;
