const schema_regex = /^[\x20-\x2E|\x30-\x5F|\x61-\x7E]*$/;

const common_validators = {
    schema_format: {
        pattern: schema_regex,
        message: "names cannot include backticks or forward slashes"
    },
    schema_length: {
        maximum: 250,
        tooLong: 'cannot exceed 250 characters'
    }
};

module.exports = {
    common_validators,
    schema_regex
};
