const clone = require('clone'),
    validator = require('./validationWrapper.js');

const actions = ["update", "insert"];
const constraints = {
    schema: {
        presence: {
            message: "is required"
        },
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: {
            message: "is required"
        },
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    action: {
        inclusion: {
            within: actions,
            message: 'is required and must be either insert or update'
        }
    },
    file_path: {},
    csv_url: {
        url: {
            allowLocal: true
        }
    },
    data: {}
};

const data_contraints = clone(constraints);
data_contraints.data.presence = {
    message: " is required"
};

const file_contraints = clone(constraints);
file_contraints.file_path.presence = {
    message: " is required"
};

const url_contraints = clone(constraints);
url_contraints.csv_url.presence = {
    message: " is required"
};

function dataObject(object) {
    return validator.validateObject(object, data_contraints);
}

function urlObject(object) {
    return validator.validateObject(object, url_contraints);
}

function fileObject(object) {
    return validator.validateObject(object, file_contraints);
}

module.exports = {
    dataObject,
    urlObject,
    fileObject
};