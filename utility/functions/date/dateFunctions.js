const moment = require('moment');

module.exports = {
    current_date: () => {
        return moment().format('YYYY-MM-DD');
    },
    current_time: () => {
        return moment().format('HH:mm:ss');
    },
    current_timestamp: () => {
        return moment().format('YYYY-MM-DD HH:mm:ss');
    },
    extract: (date_part, date)=>{
        let the_date = moment(date);
    }
};