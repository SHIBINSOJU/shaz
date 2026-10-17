const serverip = require('./serverip');
module.exports = {
    data: serverip.data.setName('ip'),
    execute: serverip.execute
};
