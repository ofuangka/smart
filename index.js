/* setup environment variables */
require('dotenv').config();

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const express = require('express');
const http = require('http');
const https = require('https');
const xml2js = require('xml2js');
const app = express();
let deviceCache = [];
const rokuPrefix = process.env.ROKU_PREFIX;
const homeassistantPrefix = process.env.HOMEASSISTANT_PREFIX;
const homeassistantPasswd = process.env.HOMEASSISTANT_PASSWD;
const port = process.env.PORT;

if (isEnvValid()) {

    /* set up middleware */
    app.use(express.json());

    /* device discovery */
    app.get('/devices', (request, response) => {

        /* discover the devices, then send the response */
        discoverDevices()

            /* set up the device cache */
            .then(() => {
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
        const ret = {};
        response.send(JSON.stringify(ret));
    });

    /* state change request */
    app.put('/devices/:deviceId/state', (request, response) => {
        const ret = {};
        response.send(JSON.stringify(ret));
    });

    /* action request */
    app.post('/devices/:deviceId/actions/:actionId', (request, response) => {
        const ret = {};
        response.send(JSON.stringify(ret));
    });

    app.listen(port);
    console.log(`smart server listening on port ${port}...`);
} else {
    console.log('environment validation failed, please check .env');
}

function isEnvValid() {
    return process.env.PORT &&
        process.env.ROKU_PREFIX &&
        process.env.EXEC_TIMEOUT &&
        process.env.HOMEASSISTANT_PREFIX &&
        process.env.HOMEASSISTANT_PASSWD;
}

function discoverDevices() {
    deviceCache.length = 0;

    return Promise.all([discoverLircDevices(), discoverRokuDevices(), discoverHomeassistantDevices()])
        .then(results => {
            const lircDevices = results[0] || [];
            const rokuDevices = results[1] || [];
            const homeassistantDevices = results[2] || [];

            console.log(homeassistantDevices);

            /* convert the devices from each platform */
            deviceCache = deviceCache.concat(
                lircDevices.map(convertLircDevice),
                rokuDevices.map(convertRokuDevice),
                homeassistantDevices
                    .filter(isHomeassistantDeviceValid)
                    .map(convertHomeassistantDevice)
            );
            return deviceCache;
        })
        .catch(err => {
            console.log(`error discovering devices: ${err}`);
        });
}

function discoverLircDevices() {
    return exec('systemctl status lircd | grep "Active: active (running)"')
        .then(result => checkExecResult(result))
        .then(result => [{
            id: 'sharp',
            name: 'TV',
            platform: 'lirc',
            capabilities: []
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
    return get(`${rokuPrefix}/`)
        .then(response => {
            return parseXml(response);
        })
        .then(xml => {
            if (xml.root && xml.root.device) {
                return xml.root.device;
            } else {
                throw new Error('invalid roku discovery response');
            }
        })
        .catch(err => {
            console.log(`error discovering roku devices: ${err}`);
        });
}

function discoverHomeassistantDevices() {
    return get(`${homeassistantPrefix}/api/states`, {
        headers: {
            'x-ha-access': homeassistantPasswd
        }
    }).then(response => JSON.parse(response));
}

function isHomeassistantDeviceValid(device) {
    return /^(light|switch|cover)\./.test(device.entity_id) && !device.attributes.hidden;
}

function convertLircDevice(source) {

    /* no conversion needed for now */
    return source;
}

function convertRokuDevice(source) {
    return {
        id: 'roku',
        platform: 'roku',
        name: source.friendlyName,
        capabilities: []
    };
}

function convertHomeassistantDevice(source) {
    return {
        id: source.entity_id,
        platform: 'homeassistant',
        name: source.attributes.friendly_name,
        capabilities: []
    };
}

function request(uri, options, postData) {
    const comps = uri.replace('//', '').split(':');
    if (comps.length === 3 && /https?/.test(comps[0]) && /^[0-9]{3,5}\/[A-Z0-9\-_~]*/i.test(comps[2])) {
        const mergedOptions = {
            protocol: `${comps[0]}:`,
            hostname: comps[1],
            port: comps[2].substring(0, comps[2].indexOf('/')),
            path: comps[2].substring(comps[2].indexOf('/')),
            headers: Object.assign(options ? options.headers : {}, { 'Content-Type': 'application/json' })
        };
        if (postData) {
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
            if (postData) {
                handle.send(postData);
            }
            handle.end();
        });
    } else {
        return Promise.reject(`could not parse uri ${uri}`);
    }
}

function get(uri, options) {
    return request(uri, options);
}

function post(uri, options, postData) {
    return request(Object.assign({}, options, { method: 'POST' }), postData);
}

function put(uri, options, postData) {
    return request(Object.assign({}, options, { method: 'PUT' }), postData);
}

function parseXml(s) {
    return util.promisify(xml2js.parseString.bind(xml2js, s))();
}