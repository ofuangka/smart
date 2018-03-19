/* setup environment variables */
require('dotenv').config();

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const express = require('express');
const http = require('http');
const https = require('https');
const xml2js = require('xml2js');

const rokuPrefix = process.env.ROKU_PREFIX;
const homeassistantPrefix = process.env.HOMEASSISTANT_PREFIX;
const homeassistantPasswd = process.env.HOMEASSISTANT_PASSWD;
const port = process.env.PORT;
const execTimeoutMs = parseInt(process.env.EXEC_TIMEOUT_MS);
const missCooldownMs = parseInt(process.env.MISS_COOLDOWN_MIN) * 60000;
const missThreshold = parseInt(process.env.MISS_THRESHOLD);
const maxArgLength = parseInt(process.env.MAX_ARG_LENGTH);

const rokuPlayback = [
    'Home',
    'Rev',
    'Fwd',
    'Play',
    'Select',
    'Left',
    'Right',
    'Down',
    'Up',
    'Back',
    'InstantReplay',
    'Info',
    'Backspace',
    'Search',
    'Enter',
    'VolumeDown',
    'VolumeMute',
    'VolumeUp',
    'PowerOff'
];

const lircCapabilities = [
    'KEY_POWER',
    'KEY_VOLUMEUP',
    'KEY_VOLUMEDOWN',
    'KEY_CHANNELUP',
    'KEY_CHANNELDOWN'
];

const homeassistantOptions = {
    headers: {
        'x-ha-access': homeassistantPasswd
    }
};

/* valid homeassistant domains */
const validHomeassistantDomains = ['light', 'cover', 'switch'];

/* track cache misses */
const deviceIdMisses = {};

/* cache devices */
let deviceCache = [];

if (isEnvValid()) {
    discoverDevices(true)
        .then(setupServer)
        .catch(err => {
            console.log('could not initialize device cache');
        });
} else {
    console.log('environment validation failed, please check .env');
}

function isEnvValid() {
    return port &&
        rokuPrefix &&
        !isNaN(execTimeoutMs) &&
        homeassistantPrefix &&
        homeassistantPasswd &&
        !isNaN(missCooldownMs) &&
        !isNaN(missThreshold) &&
        !isNaN(maxArgLength);
}

function discoverDevices(storeInCache) {
    console.log('discovering devices...');
    return Promise.all([discoverLircDevices(), discoverRokuDevices(), discoverHomeassistantDevices()])
        .then(results => {
            const lircRemotes = results[0] || [];
            const rokuApps = results[1] || [];
            const homeassistantEntities = results[2] || [];

            /* convert the devices from each platform */
            let ret = [].concat(
                lircRemotes.map(convertLircRemote),
                rokuApps
                    .filter(isRokuAppValid)
                    .map(convertRokuApp),
                homeassistantEntities
                    .filter(isEntityValid)
                    .map(convertEntity)
            );

            if (rokuApps.length > 0) {
                ret = ret.concat({
                    id: 'roku',
                    platform: 'roku',
                    name: 'Roku',
                    capabilities: rokuPlayback
                });
            }

            if (storeInCache) {
                deviceCache = ret;
            }

            return ret;
        })
        .catch(err => {
            console.log(`error discovering devices: ${err}`);
        });
}

function setupServer() {

    const app = express();

    /* set up middleware */
    app.use(express.json());

    /* device discovery */
    app.get('/devices', (request, response) => {

        /* discover the devices, then send the response */
        discoverDevices(true)

            /* set up the device cache */
            .then(devices => {
                response.send(JSON.stringify(deviceCache));
                response.end();
            })
            .catch(function (err) {
                console.log(`error discovering devices: ${err}`);
                response.status(500).send(`error discovering devices`);
            });
    });

    /* state retrieval */
    app.get('/devices/:deviceId/state', (request, response) => {
        const requestedDeviceId = request.params.deviceId;
        getDeviceIfAvailable(requestedDeviceId)
            .then(device => {
                switch (device.platform) {
                    case 'homeassistant':
                        return get(`${homeassistantPrefix}/api/states/${requestedDeviceId}`, homeassistantOptions)
                            .then(JSON.parse)
                            .then(convertEntityState)
                            .catch(err => { throw err; });
                    case 'roku':
                        return get(`${rokuPrefix}/query/active-app`)
                            .then(parseXml)
                            .then(convertRokuState)
                            .catch(err => { throw err; });
                    default:
                        throw new Error(`device ${requestedDeviceId} does not support state`);
                }
            })
            .then(state => {
                response.send(JSON.stringify(state));
                response.end();
            })
            .catch(err => response.status(500).send(`error determining ${requestedDeviceId} state: ${err}`));
    });

    /* action request */
    app.post('/devices/:deviceId/actions/:actionId', (request, response) => {
        const requestedDeviceId = request.params.deviceId;
        const requestedActionId = request.params.actionId;
        getDeviceIfAvailable(requestedDeviceId)
            .then(device => {
                if (device.capabilities.indexOf(requestedActionId) !== -1) {
                    return sendAction(requestedActionId, device);
                }
                throw new Error(`device ${requestedDeviceId} is not capable of performing action ${requestedActionId}`);
            })
            .then(upstreamResponse => {
                response.send(JSON.stringify({
                    id: requestedDeviceId,
                    action: requestedActionId
                }));
                response.end();
            })
            .catch(err => response.status(500).send(`error requesting action ${requestedActionId} for device ${requestedDeviceId}: ${err}`));
    });

    setInterval(missCooldown, missCooldownMs);

    app.listen(port);
    console.log(`server listening on port ${port}...`);
}

function convertRokuState(source) {
    const activeApp = source['active-app']['app'][0];
    return {
        id: 'roku',
        state: activeApp['$'].id,
        details: activeApp['_']
    };
}

function sendAction(actionId, device) {
    switch (device.platform) {
        case 'homeassistant':
            return post(`${homeassistantPrefix}/api/service/${sanitize(actionId)}`, homeassistantOptions, {
                entity_id: sanitize(device.id)
            });
        case 'rokuapp':
            return post(`${rokuPrefix}/${sanitize(actionId)}/${sanitize(device.id)}`, null, '');
        case 'roku':
            return post(`${rokuPrefix}/keypress/${sanitize(actionId)}`, null, '');
        case 'lirc':
            return exec(`sudo irsend send_once ${sanitize(device.id)} ${sanitize(actionId)}`);
        default:
            return Promise.reject(new Error(`unknown device platform ${device.platform}`));
    }
}

function sanitize(s) {
    return s.substring(0, maxArgLength).replace(/[^A-Z0-9_\.]/ig, '_');
}

function missCooldown() {
    console.log('cooling down...');
    const now = Date.now();
    for (let deviceId in deviceIdMisses) {
        if ((now - deviceIdMisses[deviceId].previousMiss) > missCooldownMs) {
            deviceIdMisses[deviceId].count--;
        }
    }
}

function discoverLircDevices() {
    return exec('systemctl status lircd | grep "Active: active (running)"')
        .then(result => checkExecResult(result))
        .then(result => [{
            id: 'sharp',
            name: 'TV',
            platform: 'lirc',
            capabilities: lircCapabilities
        }])
        .catch(err => {
            console.log(`error discovering lirc devices: ${err}`);
        });
}

function checkExecResult(result) {
    const { stdout, stderr } = result;
    if (stderr) {
        throw new Error(stderr);
    }
    return result;
}

function discoverRokuDevices() {
    return get(`${rokuPrefix}/query/apps`)
        .then(parseXml)
        .then(xml => {
            if (xml.apps && xml.apps.app) {
                return xml.apps.app;
            } else {
                throw new Error('invalid roku discovery response');
            }
        })
        .catch(err => {
            console.log(`error discovering roku devices: ${err}`);
        });
}

function discoverHomeassistantDevices() {
    return get(`${homeassistantPrefix}/api/states`, homeassistantOptions)
        .then(response => JSON.parse(response));
}

function isRokuAppValid(rokuApp) {
    return rokuApp['$'].type === 'appl';
}

function isEntityValid(entity) {
    return isEntityDomainValid(entity.entity_id) && !entity.attributes.hidden;
}

function isEntityDomainValid(entityId) {
    return validHomeassistantDomains.indexOf((getEntityDomain(entityId))) !== -1;
}

function getEntityDomain(entityId) {
    return entityId.substring(0, entityId.indexOf('.'));
}

function getDeviceFromCache(deviceId) {
    const devices = deviceCache.filter(device => device.id === deviceId);
    switch (devices.length) {
        case 0: return null;
        case 1: return devices[0];
        default:
            console.log(`found ${devices.length} devices when expecting 1, returning first in list`);
            return devices[0];
    }
}

function isDeviceInCache(deviceId) {
    return getDeviceFromCache(deviceId) !== null;
}

function getDeviceIfAvailable(deviceId) {
    if (isDeviceInCache(deviceId)) {
        return Promise.resolve(getDeviceFromCache(deviceId));
    }
    if (hasMoreTries(deviceId)) {
        return discoverDevices(true)
            .then(devices => {
                if (isDeviceInCache(deviceId)) {
                    return getDeviceFromCache(deviceId);
                }
                throw new Error(`device ${deviceId} not available`);
            })
            .catch(err => { throw err; });
    }
    return Promise.reject(`device ${deviceId} has no more tries`);
}

function hasMoreTries(deviceId) {
    let entry = deviceIdMisses[deviceId];
    if (!entry) {
        entry = {
            count: 0
        };
        deviceIdMisses[deviceId] = entry;
    }
    const ret = entry.count < missThreshold;
    if (ret) {
        entry.count++;
        entry.previousMiss = Date.now();
    }
    return ret;
}

function convertLircRemote(source) {

    /* no conversion needed for now */
    return source;
}

function convertRokuApp(source) {
    return {
        id: source['$'].id,
        platform: 'rokuapp',
        name: source['_'],
        capabilities: ['launch']
    };
}

function convertEntity(source) {
    return {
        id: source.entity_id,
        platform: 'homeassistant',
        name: source.attributes.friendly_name,
        capabilities: ['toggle', 'turn_on', 'turn_off']
    };
}

function convertEntityState(source) {
    return {
        id: source.entity_id,
        state: source.state
    };
}

function request(uri, options, rawPostData) {
    const comps = uri.replace('//', '').split(':');
    const postData = typeof rawPostData === 'object' ? JSON.stringify(rawPostData) : rawPostData;
    if (isCompsValid(comps)) {
        const [protocol, hostname, portAndPath] = comps;
        const port = portAndPath.substring(0, portAndPath.indexOf('/'));
        const path = portAndPath.substring(portAndPath.indexOf('/'));
        const mergedOptions = {
            protocol: `${protocol}:`,
            hostname: hostname,
            port: port,
            path: path,

            /* merge any provided headers */
            headers: Object.assign({},
                options ? options.headers : undefined,
                { 'Content-Type': 'application/json' }
            )
        };
        if (typeof postData === 'string') {

            /* make sure postData includes a Content-Length */
            mergedOptions.headers['Content-Length'] = Buffer.byteLength(postData);
        }
        return new Promise((resolve, reject) => {
            let handle = (mergedOptions.protocol === 'https:' ? https : http)
                .request(Object.assign({}, options, mergedOptions), response => {
                    let data = '';
                    response.on('data', chunk => {
                        data += chunk;
                    });
                    response.on('end', result => {
                        resolve(data);
                    });
                }).on('error', err => {
                    reject(err);
                });
            if (typeof postData === 'string') {
                handle.send(postData);
            }
            handle.end();
        });
    } else {
        return Promise.reject(new Error(`could not parse uri ${uri}`));
    }
}

function isCompsValid(comps) {
    return comps.length === 3 && /https?/.test(comps[0]) && /^[A-Z0-9\-_.]+$/i.test(comps[1]) && /^[0-9]{3,5}\/[A-Z0-9\-_~]*/i.test(comps[2]);
}

function get(uri, options) {
    return request(uri, options);
}

function post(uri, options, postData) {
    return request(Object.assign({}, options, { method: 'POST' }), postData);
}

function parseXml(s) {
    return util.promisify(xml2js.parseString.bind(xml2js, s))();
}