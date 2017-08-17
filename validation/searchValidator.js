const validate = require('validate.js');


let search_by_hash_constraints = {
    schema: {
        presence: true
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }

    },
    table: {
        presence: true
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }

    },
    hash_attribute: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    hash_value: {
        presence: true
    },
    get_attributes: {
        presence: true,
    }
};


let search_by_hashes_constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    hash_values: {
        presence: true
    },
    get_attributes: {
        presence: true,
    }
};

let search_by_value_constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },hash_attribute: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    search_attribute: {
        presence: true


    },
    search_value: {
        presence: true
    },
    get_attributes: {
        presence: true
    }
};

let search_by_conditions = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    conditions: {
        presence: true
    }/*,
    get_attributes: {
        presence: true
    }*/
};




module.exports = function(search_object, type) {
     switch(type){
         case 'hash':
             return validate(search_object, search_by_hash_constraints);
         case 'value':
             return validate(search_object, search_by_value_constraints);
         case 'hashes':
             return validate(search_object, search_by_hashes_constraints);
         case 'conditions':
             return validate(search_object, search_by_conditions);
     }
         
     
    // need to add validation to check if array for get attributes

};