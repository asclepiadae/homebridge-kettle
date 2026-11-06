'use strict'

const StaggEKGProClient = require('./lib/stagg-ekg-pro-client')
const StaggEKGProNativeClient = require('./lib/stagg-ekg-pro-native-client')

module.exports = (api) => {
    api.registerPlatform('homebridge-kettle-pro', 'StaggKettle', StaggKettlePlatform);
}

class StaggKettlePlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = new Map();

        api.on('didFinishLaunching', () => this._discoverDevices());
    }

    configureAccessory(accessory) {
        this.accessories.set(accessory.UUID, accessory);
    }

    _discoverDevices() {
        const kettles = this.config.kettles || [];
        if (kettles.length === 0) {
            this.log.warn('No kettles configured — add at least one entry under "kettles" in the platform config.');
        }
        const seen = new Set();

        for (const config of kettles) {
            const uuid = this.api.hap.uuid.generate(config.name);
            seen.add(uuid);

            let accessory = this.accessories.get(uuid);
            if (accessory) {
                accessory.context.config = config;
                this.api.updatePlatformAccessories([accessory]);
            } else {
                accessory = new this.api.platformAccessory(config.name, uuid);
                accessory.context.config = config;
                this.api.registerPlatformAccessories('homebridge-kettle-pro', 'StaggKettle', [accessory]);
                this.accessories.set(uuid, accessory);
            }
            this._setupAccessory(accessory);
        }

        for (const [uuid, accessory] of this.accessories) {
            if (!seen.has(uuid)) {
                this.api.unregisterPlatformAccessories('homebridge-kettle-pro', 'StaggKettle', [accessory]);
                this.accessories.delete(uuid);
            }
        }
    }

    _setupAccessory(accessory) {
        const config = accessory.context.config;
        const mode = String(config.connection || config.mode || '').toLowerCase();
        const { Service, Characteristic } = this.api.hap;
        if (mode === 'native') {
            new StaggEKGProNativeHandler(this.log, config, accessory, this.api);
        } else if (mode === 'wifi') {
            new StaggEKGProWifiHandler(this.log, config, accessory, Service, Characteristic);
        } else {
            new StaggEKGPlusHandler(this.log, config, accessory, Service, Characteristic);
        }
    }
}


// Firmware 1.2.26: the CLI is muted, so state comes from the native `/temp` endpoint.
// The kettle turns its Wi-Fi off while heating or holding, so it is polled in the
// background and HomeKit reads answer from the last known state instead of waiting
// on the network.
class StaggEKGProNativeHandler {
    constructor(log, config, accessory, api) {
        const { Service, Characteristic, HapStatusError, HAPStatus } = api.hap;
        this.log = log;
        this.name = config.name;
        this.client = new StaggEKGProNativeClient(config.url);
        this.minTemp = typeof config.minTemp === 'number' ? config.minTemp : 40;
        this.maxTemp = typeof config.maxTemp === 'number' ? config.maxTemp : 100;
        this.heating = null;
        this.currentTemp = null;
        this.targetTemp = null;
        this.online = null;

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Fellow')
            .setCharacteristic(Characteristic.Model, 'Stagg EKG Pro')
            .setCharacteristic(Characteristic.SerialNumber, '123-456-789');

        const service = accessory.getService(Service.Thermostat)
            || accessory.addService(Service.Thermostat);

        const known = (value) => {
            if (value === null) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            return value;
        };

        this.currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(() => known(this.heating === null ? null : Number(this.heating)));

        this.targetState = service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(() => known(this.heating === null ? null : Number(this.heating)))
            .onSet(async (value) => {
                if (this.heating !== null && value === Number(this.heating)) return;
                this.log.warn(`${this.name}: firmware 1.2.26 can't be switched on or off over Wi-Fi; use the kettle or the Fellow app.`);
                setTimeout(() => {
                    if (this.heating !== null) this.targetState.updateValue(Number(this.heating));
                }, 100);
                throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
            });

        this.targetTempChar = service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 0.5 })
            .onGet(() => known(this.targetTemp))
            .onSet(async (value) => {
                try {
                    const actual = await this.client.setTargetTemp(value);
                    this.targetTemp = this._clampTarget(actual);
                } catch (err) {
                    this.log.warn(`${this.name}: could not set the target temperature to ${value} °C: ${err.message}`);
                    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
            });

        this.currentTempChar = service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: 120 })
            .onGet(() => known(this.currentTemp));

        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => 0)
            .onSet(async () => {});

        const seconds = Math.max(5, Number(config.pollInterval) || 15);
        this._poll();
        const timer = setInterval(() => this._poll(), seconds * 1000);
        api.on('shutdown', () => clearInterval(timer));
    }

    _clampTarget(value) {
        return Math.min(this.maxTemp, Math.max(this.minTemp, Math.round(value * 2) / 2));
    }

    async _poll() {
        let status;
        try {
            status = await this.client.status();
        } catch (err) {
            if (this.online !== false) {
                this.log.warn(`${this.name}: no answer from ${this.client.root}/temp (${err.message}). `
                    + 'The kettle turns its Wi-Fi off while heating or holding; HomeKit shows the last known state until it answers again.');
            }
            this.online = false;
            return;
        }
        if (this.online === false) this.log.info(`${this.name}: answering again.`);
        this.online = true;

        if (status.heating !== null) {
            this.heating = status.heating;
            this.currentState.updateValue(Number(this.heating));
            this.targetState.updateValue(Number(this.heating));
        }
        if (status.currentTemp !== null) {
            this.currentTemp = Math.min(120, Math.max(0, status.currentTemp));
            this.currentTempChar.updateValue(this.currentTemp);
        }
        this.targetTemp = this._clampTarget(status.targetTemp);
        this.targetTempChar.updateValue(this.targetTemp);
    }
}


class StaggEKGProWifiHandler {
    constructor(log, config, accessory, Service, Characteristic) {
        const client = new StaggEKGProClient(config.url);
        const minTemp = typeof config.minTemp === 'number' ? config.minTemp : 40;
        const maxTemp = typeof config.maxTemp === 'number' ? config.maxTemp : 100;

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Fellow')
            .setCharacteristic(Characteristic.Model, 'Stagg EKG Pro')
            .setCharacteristic(Characteristic.SerialNumber, '123-456-789');

        const service = accessory.getService(Service.Thermostat)
            || accessory.addService(Service.Thermostat);

        service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const value = client.parseState(body);
                if (value === null) throw new Error(`unrecognised state: ${body.trim()}`);
                return value;
            })
            .onSet(async (value) => {
                await client.commandAsync(`setstate ${client.stateForHomeKit(value)}`);
            });

        service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const value = client.parseState(body);
                if (value === null) throw new Error(`unrecognised state: ${body.trim()}`);
                return value;
            });

        service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const targetC = client.parseTargetTemp(body);
                if (targetC === null) throw new Error(`could not parse target temp: ${body.trim()}`);
                return targetC;
            })
            .onSet(async (value) => {
                const targetF = Math.round(client.cToF(value));
                await Promise.all([
                    client.commandAsync(`setsetting settempr ${targetF}`),
                    client.commandAsync(`setstate S_Heat`),
                ]);
            });

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: maxTemp })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const tempC = client.parseTemp(body);
                if (tempC === null) throw new Error(`could not parse current temp: ${body.trim()}`);
                return tempC;
            });

        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => 0)
            .onSet(async () => {});
    }
}


class StaggEKGPlusHandler {
    constructor(log, config, accessory, Service, Characteristic) {
        const url = config.url;
        const minTemp = typeof config.minTemp === 'number' ? config.minTemp : 40;
        const maxTemp = typeof config.maxTemp === 'number' ? config.maxTemp : 100;
        const _fetch = (path, opts = {}) =>
            fetch(url + path, { signal: AbortSignal.timeout(5000), ...opts });

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Fellow')
            .setCharacteristic(Characteristic.Model, 'Stagg EKG+')
            .setCharacteristic(Characteristic.SerialNumber, '123-456-789');

        const service = accessory.getService(Service.Thermostat)
            || accessory.addService(Service.Thermostat);

        service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(async () => {
                const body = await _fetch('/state').then(r => r.text());
                return parseFloat(body);
            })
            .onSet(async (value) => {
                await _fetch('/state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'value=' + value,
                });
            });

        service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp })
            .onGet(async () => {
                const body = await _fetch('/target_temp').then(r => r.text());
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) throw new Error(`could not parse target temp: ${body}`);
                return tempC;
            })
            .onSet(async (value) => {
                await _fetch('/target_temp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'value=' + value,
                });
            });

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: maxTemp })
            .onGet(async () => {
                const body = await _fetch('/current_temp').then(r => r.text());
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) throw new Error(`could not parse current temp: ${body}`);
                return tempC;
            });

        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => 0)
            .onSet(async () => {});
    }
}
