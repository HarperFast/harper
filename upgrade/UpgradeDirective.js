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
        // Function that builds updated settings file
        this.settings_file_functions = [];
        // Functions can be added into this which will be run after the paths are created.  Functions must be
        // synchronous.
        this.functions = [];
    }
}

module.exports = UpgradeDirective;
