const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { defaultConfig, defaultDeviceConfig } = require('../dist/platformUtils.js');
const { discoverDevices, getDevicePassword } = require('./discovery.js');
const fs = require('fs').promises;

class UiServer extends HomebridgePluginUiServer {
    constructor() {
        super();
        this.onRequest('/discover', this.handleDiscoverDevices.bind(this));
        this.ready();
    }

    async handleDiscoverDevices(payload) {
        const { username, password } = payload;

        if (!username || !password) {
            throw new RequestError('Username and password are required.');
        }

        try {
            const devices = await discoverDevices();
            const updatedDevices = [];

            for (const device of devices) {
                const devicePassword = await getDevicePassword(username, password);
                updatedDevices.push({
                    name: device.hostname,
                    model: device.robotModel,
                    serialnum: device.robotName,
                    ipaddress: device.ip,
                    password: devicePassword
                });
            }

            await this.updateConfigSchema(updatedDevices);
            return updatedDevices;
        } catch (error) {
            throw new RequestError('Failed to discover devices: ' + error.message);
        }
    }

    async updateConfigSchema(devices) {
        try {
            const configPath = './config.schema.json';
            const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
            config.devices = devices;
            await fs.writeFile(configPath, JSON.stringify(config, null, 2));
        } catch (error) {
            throw new Error('Failed to update config schema: ' + error.message);
        }
    }
}

(() => {
    return new UiServer();
})();
