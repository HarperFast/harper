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
        switch(date_part.toLowerCase()){
            case 'year':
                return moment(date).format('YYYY');
                break;
            case 'month':
                return moment(date).format('MM');
                break;
            case 'day':
                return moment(date).format('DD');
                break;
            case 'hour':
                return moment(date).format('HH');
                break;
            case 'minute':
                return moment(date).format('mm');
                break;
            case 'second':
                return moment(date).format('ss');
                break;
            case 'millisecond':
                return moment(date).format('SSS');
                break;
            default:
                break;
        }
    }
};