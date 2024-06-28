import { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { IRobotPlatform } from './platform';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, IRobotPlatform);
};