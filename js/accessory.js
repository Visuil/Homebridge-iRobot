import dorita980 from "dorita980";
import { Local } from "dorita980";
import { AccessoryPlugin, Service, Characteristic, Logging, API } from "homebridge";

// Constants
const CONNECT_TIMEOUT_MILLIS = 60_000;
const USER_INTERESTED_MILLIS = 60_000;
const AFTER_ACTIVE_MILLIS = 120_000;
const STATUS_TIMEOUT_MILLIS = 60_000;
const REFRESH_STATE_COALESCE_MILLIS = 10_000;
const ROBOT_CIPHERS = ["AES128-SHA256", "TLS_AES_256_GCM_SHA384"];

// Errors
const NO_VALUE = new Error("No value");

// Helper Functions
async function delay(duration: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, duration);
    });
}

function millisToString(millis: number): string {
    if (millis < 1_000) {
        return `${millis}ms`;
    } else if (millis < 60_000) {
        return `${Math.round((millis / 1000) * 10) / 10}s`;
    } else {
        return `${Math.round((millis / 60_000) * 10) / 10}m`;
    }
}

function shouldTryDifferentCipher(error: Error): boolean {
    if (error.message.indexOf("TLS") !== -1) {
        return true;
    }
    if (error.message.toLowerCase().indexOf("identifier rejected") !== -1) {
        return true;
    }
    return false;
}

interface Config {
    debug?: boolean;
    name: string;
    model: string;
    serialnum: string;
    blid: string;
    robotpwd: string;
    ipaddress: string;
    cleanBehaviour?: string;
    mission?: string;
    stopBehaviour?: string;
    idleWatchInterval?: number;
    dockContactSensor?: boolean;
    runningContactSensor?: boolean;
    binContactSensor?: boolean;
    dockingContactSensor?: boolean;
    homeSwitch?: boolean;
}

interface RoombaStatus {
    running?: boolean;
    batteryLevel?: number;
    charging?: boolean;
    binFull?: boolean;
    docking?: boolean;
}

class RoombaAccessory implements AccessoryPlugin {
    private readonly api: API;
    private readonly log: Logging;
    private readonly debug: boolean;
    private readonly name: string;
    private readonly model: string;
    private readonly serialnum: string;
    private readonly blid: string;
    private readonly robotpwd: string;
    private readonly ipaddress: string;
    private readonly cleanBehaviour: string;
    private readonly mission?: string;
    private readonly stopBehaviour: string;
    private readonly idlePollIntervalMillis: number;
    private lastRefreshState: number = 0;
    private lastPollInterval: number = 0;
    private cachedStatus: RoombaStatus = {};
    private _currentRoombaPromise?: Promise<{ roomba: any, useCount: number }>;
    private currentCipherIndex: number = 0;
    private readonly accessoryInfo: Service;
    private readonly filterMaintenance: Service;
    private readonly switchService: Service;
    private readonly batteryService: Service;
    private dockService?: Service;
    private runningService?: Service;
    private binService?: Service;
    private dockingService?: Service;
    private homeService?: Service;

    constructor(log: Logging, config: Config, api: API) {
        this.api = api;
        this.debug = !!config.debug;

        this.log = !this.debug
            ? log
            : Object.assign(log, {
                debug: (message: string, ...parameters: unknown[]) => {
                    log.info(`DEBUG: ${message}`, ...parameters);
                },
            });
        this.name = config.name;
        this.model = config.model;
        this.serialnum = config.serialnum;
        this.blid = config.blid;
        this.robotpwd = config.robotpwd;
        this.ipaddress = config.ipaddress;
        this.cleanBehaviour = config.cleanBehaviour !== undefined ? config.cleanBehaviour : "everywhere";
        this.mission = config.mission;
        this.stopBehaviour = config.stopBehaviour !== undefined ? config.stopBehaviour : "home";
        this.idlePollIntervalMillis = (config.idleWatchInterval || 15) * 60_000;

        const showDockAsContactSensor = config.dockContactSensor === undefined ? true : config.dockContactSensor;
        const showRunningAsContactSensor = !!config.runningContactSensor;
        const showBinStatusAsContactSensor = !!config.binContactSensor;
        const showDockingAsContactSensor = !!config.dockingContactSensor;
        const showHomeSwitch = !!config.homeSwitch;

        this.accessoryInfo = new Service.AccessoryInformation();
        this.filterMaintenance = new Service.FilterMaintenance(this.name);
        this.switchService = new Service.Switch(this.name);
        this.switchService.setPrimaryService(true);
        this.batteryService = new Service.BatteryService(this.name);
        if (showDockAsContactSensor) {
            this.dockService = new Service.ContactSensor(this.name + " Dock", "docked");
        }
        if (showRunningAsContactSensor) {
            this.runningService = new Service.ContactSensor(this.name + " Running", "running");
        }
        if (showBinStatusAsContactSensor) {
            this.binService = new Service.ContactSensor(this.name + " Bin Full", "Full");
        }
        if (showDockingAsContactSensor) {
            this.dockingService = new Service.ContactSensor(this.name + " Docking", "docking");
        }
        if (showHomeSwitch) {
            this.homeService = new Service.Switch(this.name + " Home", "returning");
        }

        const version = require("../package.json").version;

        this.accessoryInfo.setCharacteristic(Characteristic.Manufacturer, "iRobot");
        this.accessoryInfo.setCharacteristic(Characteristic.SerialNumber, this.serialnum);
        this.accessoryInfo.setCharacteristic(Characteristic.Identify, true);
        this.accessoryInfo.setCharacteristic(Characteristic.Name, this.name);
        this.accessoryInfo.setCharacteristic(Characteristic.Model, this.model);
        this.accessoryInfo.setCharacteristic(Characteristic.FirmwareRevision, version);

        // Register Event Handlers
        this.registerEventHandlers();

        this.startPolling();
    }

    private registerEventHandlers() {
        this.switchService
            .getCharacteristic(Characteristic.On)
            .on("set", this.setRunningState.bind(this))
            .on("get", this.createCharacteristicGetter("Running status", this.runningStatus.bind(this)));

        this.batteryService
            .getCharacteristic(Characteristic.BatteryLevel)
            .on("get", this.createCharacteristicGetter("Battery level", this.batteryLevelStatus.bind(this)));

        this.batteryService
            .getCharacteristic(Characteristic.ChargingState)
            .on("get", this.createCharacteristicGetter("Charging status", this.chargingStatus.bind(this)));

        this.batteryService
            .getCharacteristic(Characteristic.StatusLowBattery)
            .on("get", this.createCharacteristicGetter("Low Battery status", this.batteryStatus.bind(this)));

        this.filterMaintenance
            .getCharacteristic(Characteristic.FilterChangeIndication)
            .on("get", this.createCharacteristicGetter("Bin status", this.binStatus.bind(this)));

        if (this.dockService) {
            this.dockService
                .getCharacteristic(Characteristic.ContactSensorState)
                .on("get", this.createCharacteristicGetter("Dock status", this.dockedStatus.bind(this)));
        }
        if (this.runningService) {
            this.runningService
                .getCharacteristic(Characteristic.ContactSensorState)
                .on("get", this.createCharacteristicGetter("Running status", this.runningStatus.bind(this)));
        }
        if (this.binService) {
            this.binService
                .getCharacteristic(Characteristic.ContactSensorState)
                .on("get", this.createCharacteristicGetter("Bin status", this.binStatus.bind(this)));
        }
        if (this.dockingService) {
            this.dockingService
                .getCharacteristic(Characteristic.ContactSensorState)
                .on("get", this.createCharacteristicGetter("Docking status", this.dockingStatus.bind(this)));
        }
        if (this.homeService) {
            this.homeService
                .getCharacteristic(Characteristic.On)
                .on("set", this.setDockingState.bind(this))
                .on("get", this.createCharacteristicGetter("Returning Home", this.dockingStatus.bind(this)));
        }
    }

    identify() {
        this.log.info("Identify requested");
        this.connect((error, roomba) => {
            if (error || !roomba) {
                return;
            }
            roomba.find().catch((err: Error) => {
                this.log.warn("Roomba failed to locate: %s", err.message);
            });
        });
    }

    getServices(): Service[] {
        const services = [
            this.accessoryInfo,
            this.switchService,
            this.batteryService,
            this.filterMaintenance,
        ];

        if (this.dockService) {
            services.push(this.dockService);
        }
        if (this.runningService) {
            services.push(this.runningService);
        }
        if (this.binService) {
            services.push(this.binService);
        }
        if (this.dockingService) {
            services.push(this.dockingService);
        }
        if (this.homeService) {
            services.push(this.homeService);
        }

        return services;
    }

    private refreshState(callback: (success: boolean) => void) {
        const now = Date.now();

        this.connect((error, roomba) => {
            if (error || !roomba) {
                this.log.warn("Failed to refresh Roomba's state: %s", error ? error.message : "Unknown");
                callback(false);
                return;
            }

            const startedWaitingForStatus = Date.now();

            new Promise<void>((resolve) => {
                let receivedState: RoombaStatus | undefined;

                const timeout = setTimeout(() => {
                    this.log.debug(
                        "Timeout waiting for full state from Roomba (%ims). Last state received was: %s",
                        Date.now() - startedWaitingForStatus,
                        receivedState ? JSON.stringify(receivedState) : "<none>"
                    );
                    resolve();
                    callback(false);
                }, STATUS_TIMEOUT_MILLIS);

                const updateState = (state: RoombaStatus) => {
                    receivedState = state;

                    if (this.receivedRobotStateIsComplete(state)) {
                        clearTimeout(timeout);

                        this.log.debug(
                            "Refreshed Roomba's state in %ims: %s",
                            Date.now() - now,
                            JSON.stringify(state)
                        );

                        roomba.off("state", updateState);
                        resolve();
                        callback(true);
                    }
                };
                roomba.on("state", updateState);
            });
        });
    }

    private receivedRobotStateIsComplete(state: RoombaStatus): boolean {
        return state.batteryLevel !== undefined && state.binFull !== undefined && state.docking !== undefined;
    }

    private receiveRobotState(state: RoombaStatus): boolean {
        const parsed = this.parseState(state);
        this.mergeCachedStatus(parsed);
        return true;
    }

    private connectedRoomba(attempts = 0): Promise<{ roomba: any, useCount: number }> {
        return new Promise((resolve, reject) => {
            let connected = false;
            let failed = false;

            const roomba = new Local(this.blid, this.robotpwd, this.ipaddress, 2, {
                ciphers: ROBOT_CIPHERS[this.currentCipherIndex]
            });

            const startConnecting = Date.now();
            const timeout = setTimeout(() => {
                failed = true;
                this.log.debug("Timed out after %ims trying to connect to Roomba", Date.now() - startConnecting);

                roomba.end();
                reject(new Error("Connect timed out"));
            }, CONNECT_TIMEOUT_MILLIS);

            roomba.on("state", (state: RoombaStatus) => { this.receiveRobotState(state); });

            const onError = (error: Error) => {
                this.log.debug("Connection received error: %s", error.message);

                roomba.off("error", onError);
                roomba.end();
                clearTimeout(timeout);

                if (!connected) {
                    failed = true;

                    if (error instanceof Error && shouldTryDifferentCipher(error) && attempts < ROBOT_CIPHERS.length) {
                        this.currentCipherIndex = (this.currentCipherIndex + 1) % ROBOT_CIPHERS.length;
                        this.log.debug("Retrying connection to Roomba with cipher %s", ROBOT_CIPHERS[this.currentCipherIndex]);
                        this.connectedRoomba(attempts + 1).then(resolve).catch(reject);
                    } else {
                        reject(error);
                    }
                }
            };
            roomba.on("error", onError);

            this.log.debug("Connecting to Roomba...");

            const onConnect = () => {
                roomba.off("connect", onConnect);
                clearTimeout(timeout);

                if (failed) {
                    this.log.debug("Connection established to Roomba after failure");
                    return;
                }

                connected = true;

                this.log.debug("Connected to Roomba in %ims", Date.now() - startConnecting);
                resolve({
                    roomba,
                    useCount: 0,
                });
            };
            roomba.on("connect", onConnect);
        });
    }

    private connect(callback: (error: Error | null, roomba?: any) => void) {
        const promise = this._currentRoombaPromise || this.connectedRoomba();
        this._currentRoombaPromise = promise;

        promise.then((holder) => {
            holder.useCount++;
            callback(null, holder.roomba).finally(() => {
                holder.useCount--;

                if (holder.useCount <= 0) {
                    this._currentRoombaPromise = undefined;
                    holder.roomba.end();
                } else {
                    this.log.debug("Leaving Roomba instance with %i ongoing requests", holder.useCount);
                }
            });
        }).catch((error) => {
            this._currentRoombaPromise = undefined;
            callback(error);
        });
    }

    private setRunningState(powerOn: boolean, callback: (error?: Error) => void) {
        if (powerOn) {
            this.log.info("Starting Roomba");

            this.connect((error, roomba) => {
                if (error || !roomba) {
                    callback(error || new Error("Unknown error"));
                    return;
                }

                if (this.cachedStatus.paused) {
                    roomba.resume().then(() => {
                        callback();
                        this.refreshStatusForUser();
                    }).catch((err: Error) => {
                        this.log.warn("Roomba failed: %s", err.message);
                        callback(err);
                    });
                } else {
                    if (this.cleanBehaviour === "rooms") {
                        roomba.cleanRoom(this.mission).then(() => {
                            this.log.debug("Roomba is cleaning your rooms");
                            callback();
                            this.refreshStatusForUser();
                        }).catch((err: Error) => {
                            this.log.warn("Roomba failed: %s", err.message);
                            callback(err);
                        });
                    } else {
                        roomba.clean().then(() => {
                            this.log.debug("Roomba is running");
                            callback();
                            this.refreshStatusForUser();
                        }).catch((err: Error) => {
                            this.log.warn("Roomba failed: %s", err.message);
                            callback(err);
                        });
                    }
                }
            });
        } else {
            this.log.info("Stopping Roomba");

            this.connect((error, roomba) => {
                if (error || !roomba) {
                    callback(error || new Error("Unknown error"));
                    return;
                }

                roomba.getRobotState(["cleanMissionStatus"]).then((response: RoombaStatus) => {
                    const state = this.parseState(response);

                    if (state.running) {
                        this.log.debug("Roomba is pausing");

                        roomba.pause().then(() => {
                            callback();

                            if (this.stopBehaviour === "home") {
                                this.log.debug("Roomba paused, returning to Dock");
                                this.dockWhenStopped(roomba, 3000);
                            } else {
                                this.log.debug("Roomba is paused");
                            }
                        }).catch((err: Error) => {
                            this.log.warn("Roomba failed: %s", err.message);
                            callback(err);
                        });
                    } else if (state.docking) {
                        this.log.debug("Roomba is docking");
                        roomba.pause().then(() => {
                            callback();
                            this.log.debug("Roomba paused");
                        }).catch((err: Error) => {
                            this.log.warn("Roomba failed: %s", err.message);
                            callback(err);
                        });
                    } else if (state.charging) {
                        this.log.debug("Roomba is already docked");
                        callback();
                    } else {
                        this.log.debug("Roomba is not running");
                        callback();
                    }

                    this.refreshStatusForUser();
                }).catch((err: Error) => {
                    this.log.warn("Roomba failed: %s", err.message);
                    callback(err);
                });
            });
        }
    }

    private setDockingState(docking: boolean, callback: (error?: Error) => void) {
        this.log.debug("Setting docking state to %s", JSON.stringify(docking));

        this.connect((error, roomba) => {
            if (error || !roomba) {
                callback(error || new Error("Unknown error"));
                return;
            }

            if (docking) {
                roomba.dock().then(() => {
                    this.log.debug("Roomba is docking");
                    callback();
                    this.refreshStatusForUser();
                }).catch((err: Error) => {
                    this.log.warn("Roomba failed: %s", err.message);
                    callback(err);
                });
            } else {
                roomba.pause().then(() => {
                    this.log.debug("Roomba is paused");
                    callback();
                    this.refreshStatusForUser();
                }).catch((err: Error) => {
                    this.log.warn("Roomba failed: %s", err.message);
                    callback(err);
                });
            }
        });
    }

    private async dockWhenStopped(roomba: any, pollingInterval: number) {
            try {
                const state = await roomba.getRobotState(["cleanMissionStatus"]);

                switch (state.cleanMissionStatus.phase) {
                    case "stop":
                        this.log.debug("Roomba has stopped, issuing dock request");
                        await roomba.dock();
                        this.log.debug("Roomba docking");
                        this.refreshStatusForUser();
                        break;
                    case "run":
                        this.log.debug("Roomba is still running. Will check again in %is", pollingInterval / 1000);
                        await delay(pollingInterval);
                        this.log.debug("Trying to dock again...");
                        await this.dockWhenStopped(roomba, pollingInterval);
                        break;
                    default:
                        this.log.debug("Roomba is in unexpected state: %s", state.cleanMissionStatus.phase);
                        break;
                }
            } catch (error) {
                this.log.warn("Roomba failed to dock: %s", (error as Error).message);
            }
        }

    refreshStatusForUser() {
        this.log.debug("Fetching updated status for user");

        if (this.refreshToken) {
            clearTimeout(this.refreshToken);
            this.refreshToken = null;
        }

        this.refreshState((success) => {
            if (success) {
                this.log.debug("User status updated, scheduling next update");
                this.scheduleNextUpdate();
            } else {
                this.log.debug("Failed to update user status");
            }
        });
    }

    scheduleNextUpdate() {
        this.log.debug("Scheduling next update in %ims", this.idlePollIntervalMillis);
        this.refreshToken = setTimeout(() => {
            this.log.debug("Executing scheduled update");
            this.refreshStatusForUser();
        }, this.idlePollIntervalMillis);
    }

    parseState(state: any) {
        const mappedState = {
            running: state.cleanMissionStatus.phase === "run",
            paused: state.cleanMissionStatus.phase === "pause",
            docking: state.cleanMissionStatus.phase === "hmPostMsn",
            batteryLevel: state.batPct,
            charging: state.cleanMissionStatus.phase === "charge",
            binFull: state.bin.full,
        };

        return mappedState;
    }

    mergeCachedStatus(newStatus: any) {
        this.cachedStatus = Object.assign({}, this.cachedStatus, newStatus);
        this.lastRefreshState = Date.now();
    }

    startPolling() {
        this.log.debug("Starting poll for device state");

        this.refreshState((success) => {
            if (success) {
                this.log.debug("Initial state obtained, setting up polling");
                this.scheduleNextUpdate();
            } else {
                this.log.debug("Failed to obtain initial state, retrying");
                setTimeout(() => this.startPolling(), 10_000);
            }
        });
    }

    module.exports = RoombaAccessory;
