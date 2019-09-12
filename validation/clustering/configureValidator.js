const validator = require('../validationWrapper.js');
const terms = require('../../utility/hdbTerms');
const hdb_utils = require('../../utility/common_utils');
const fs = require('fs-extra');
const validate = require('validate.js');

async function doesPathExist(path) {
    let exists = await fs.pathExists(path);
    if(exists) {
        return null;
    }
    return new Error(`Specified path ${path} does not exist.`);
}

validate.validators.doesPathExist = doesPathExist;

const constraints = {
    PROJECT_DIR: {
        presence: false,
        format: {
            pattern: "/^\\/|\\/\\/|(\\/[\\w-]+)+$",
            message: "must be a valid unix directory path."
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        },
        doesPathExist
    },
    HDB_ROOT: {
        presence: false,
        format: {
            pattern: "/^\\/|\\/\\/|(\\/[\\w-]+)+$",
            message: "must be a valid unix directory path."
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        },
        doesPathExist
    },
    HTTP_PORT: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 1000,
            lessThanOrEqualTo: 65534,
            message: 'must specify a valid port integer greater than 1000 and less than 65,354.'
        }
    },
    HTTPS_PORT: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 1000,
            lessThanOrEqualTo: 65534,
            message: 'must specify a valid port integer greater than 1000 and less than 65,354.'
        }
    },
    CERTIFICATE: {
        presence: false,
        format: {
            pattern: "^((?!.*\\/\\/.*)(?!.*\\/ .*)\\/{1}([^\\\\(){}:\\*\\?<>\\|\\\"\\'])+\\.(pem))$",
            message: "must be a valid unix directory path and specify a .pem file."
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        },
        doesPathExist
    },
    PRIVATE_KEY: {
        presence: false,
        format: {
            pattern: "^((?!.*\\/\\/.*)(?!.*\\/ .*)\\/{1}([^\\\\(){}:\\*\\?<>\\|\\\"\\'])+\\.(pem))$",
            message: "must be a valid unix directory path and specify a .pem file."
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        },
        doesPathExist
    },
    HTTPS_ON: {
        presence: false,
        inclusion: {
            within: [true, false, "true", "false"],
            message: "must be true or false."
        }
    },
    HTTP_ON: {
        presence: false,
        inclusion: {
            within: [true, false, "true", "false"],
            message: "must be true or false."
        }
    },
    CORS_ON: {
        presence: false,
        inclusion: {
            within: [true, false, "true", "false"],
            message: "must be true or false."
        }
    },
    CORS_WHITELIST: {
        presence: false
    },
    SERVER_TIMEOUT_MS: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 60000,
            lessThanOrEqualTo: 1200000,
            message: 'must specify Milliseconds over 60,000 (1 minute) and less than 1200000 (20 minutes).'
        }
    },
    LOG_LEVEL: {
        presence: false,
        inclusion: {
            within: ["trace", "debug", "info", "error", "fatal", "notify"],
            message: "must be trace, debug, info, error, fatal or notify."
        }
    },
    LOGGER: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 0,
            lessThanOrEqualTo: 2,
            message: 'must specify an integer of 1 to use Winston, 2 to use Pino.'
        }
    },
    LOG_PATH: {
        presence: false,
        format: {
            pattern: "^((?!.*\\/\\/.*)(?!.*\\/ .*)\\/{1}([^\\\\(){}:\\*\\?<>\\|\\\"\\'])+\\.(log))$",
            message: "must be a valid unix file path structure to a file ending in .log."
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    LOG_DAILY_ROTATE: {
        presence: false,
        inclusion: {
            within: [true, false, "true", "false"],
            message: "must be true or false."
        }
    },
    LOG_MAX_DAILY_FILES: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 0,
            lessThanOrEqualTo: 100,
            message: 'must specify a valid integer greater than 0 and less than 100'
        }
    },
    ALLOW_SELF_SIGNED_SSL_CERTS: {
        presence: false,
        inclusion: {
            within: [true, false, "true", "false"],
            message: "must be true or false."
        }
    },
    MAX_HDB_PROCESSES: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 0,
            lessThanOrEqualTo: 1000,
            message: 'must specify an integer greater than 0 and less than 1000'
        }
    },
    CLUSTERING: {
        presence: false,
        inclusion: {
            within: [true, false, "true", "false"],
            message: "must be true or false."
        }
    },
    CLUSTERING_PORT: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 1000,
            lessThanOrEqualTo: 65534,
            message: 'must specify a valid port integer greater than 1000 and less than 65,354.'
        }
    },
    NODE_ENV: {
        presence: false,
        inclusion: {
            within: ["production", "development"],
            message: "must be production or development."
        }
    },
    NODE_NAME: {
        presence: false,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        }
    },
    CLUSTERING_USER: {
        presence: false,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    }
};

module.exports = async function (config_object) {
    // ensure all fields specified are a valid setting
    let msg_keys = Object.keys(config_object);
    for(let i=0; i<msg_keys.length; ++i) {
        let curr = msg_keys[i];
        if(!curr || hdb_utils.isEmptyOrZeroLength(terms.HDB_SETTINGS_NAMES_REVERSE_LOOKUP[curr])) {
            return new Error(`Invalid config setting specified: ${curr}`);
        }
    }
    let result = undefined;
    try {
        result = await validator.validateObjectAsync(config_object, constraints);
    } catch(err) {
        result = err;
    }
    return result;
};