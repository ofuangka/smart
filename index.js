/* setup environment variables */
require('dotenv').config();

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const express = require('express');
const app = express();
const deviceCache = [];
const rokuUri = process.env.ROKU_URI;
const port = process.env.PORT;

if (isEnvValid()) {

    /* set up middleware */
    app.use(express.json());

    /* device discovery */
    app.get('/devices', (request, response) => {

        /* discover the devices, then send the response */
        discoverDevices()

            /* set up the device cache */
            .then(() => response.send(JSON.stringify(deviceCache)))
            .catch(function (err) {
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
    /* TODO: implement */
    return true;
}

function discoverDevices() {
    deviceCache.length = 0;

    return Promise.all([discoverLircDevices(), discoverRokuDevices(), discoverHomeassistantDevices()])
        .then(results => {
            const lircDevices = results[0] || [];
            const rokuDevices = results[1] || [];
            const homeassistantDevices = results[2] || [];

            /* convert the devices from each platform */
            deviceCache.concat(
                lircDevices.map(convertLircDevice),
                rokuDevices.map(convertRokuDevice),
                homeassistantDevices.map(convertHomeassistantDevice)
            );
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
    return exec(`curl ${rokuUri}`)
        .then(checkExecResult)
        .then(result => {
            return [{
                id: 'roku',
                name: 'Roku',
                platform: 'roku',
                capabilities: []
            }];
        })
        .catch(err => {
            console.log(`error discovering roku devices: ${err}`);
        });
}

function discoverHomeassistantDevices() {
    return Promise.resolve([]);
}

function convertLircDevice(source) {

    /* no conversion needed for now */
    return source;
}

function convertRokuDevice(source) {

    /* no conversion needed for now */
    return source;

}

function convertHomeassistantDevice(source) {
    return source;
}