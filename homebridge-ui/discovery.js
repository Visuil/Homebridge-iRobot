const dorita980 = require('dorita980');
const { exec } = require('child_process');
const util = require('util');

function discoverDevices() {
    return new Promise((resolve, reject) => {
        dorita980.discovery((err, devices) => {
            if (err) {
                reject(err);
            } else {
                resolve(devices);
            }
        });
    });
}

function getDevicePassword(username, password) {
    return new Promise((resolve, reject) => {
        exec(`get-roomba-password-cloud ${username} ${password}`, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Error getting device password: ${stderr || error.message}`));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

module.exports = {
    discoverDevices,
    getDevicePassword
};
