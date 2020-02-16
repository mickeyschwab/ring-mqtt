#!/usr/bin/env node

// Defines
const RingApi = require ('ring-client-api').RingApi
const mqttApi = require ('mqtt')
const debug = require('debug')('ring-mqtt')
const colors = require('colors/safe')
const utils = require('./lib/utils.js')
const SecurityPanel = require('./devices/security-panel')
const ContactSensor = require('./devices/contact-sensor')
const MotionSensor = require('./devices/motion-sensor')
const FloodFreezeSensor = require('./devices/flood-freeze-sensor')
const SmokeCoListener = require('./devices/smoke-co-listener')
const SmokeAlarm = require('./devices/smoke-alarm')
const CoAlarm = require('./devices/co-alarm')
const Lock = require('./devices/lock')
const Switch = require('./devices/switch')
const MultiLevelSwitch = require('./devices/multi-level-switch')
const Fan = require('./devices/fan')
const Camera = require('./devices/camera')

var CONFIG
var ringTopic
var hassTopic
var mqttClient
var mqttConnected = false
var ringLocations = new Array()
var subscribedLocations = new Array()
var subscribedDevices = new Array()
var publishAlarm = true  // Flag to stop publish/republish if connection is down
var republishCount = 10 // Republish config/state this many times after startup or HA start/restart
var republishDelay = 30 // Seconds

// Setup Exit Handwlers
process.on('exit', processExit.bind(null, {cleanup:true}, 0))
process.on('SIGINT', processExit.bind(null, {cleanup:true}, 0))
process.on('SIGTERM', processExit.bind(null, {cleanup:true}, 0))
process.on('uncaughtException', processExit.bind(null, {cleanup:true}, 1))

// Set unreachable status on exit
async function processExit(options, exitCode) {
    if (options.cleanup) {
        ringLocations.forEach(async location => {
            availabilityTopic = ringTopic+'/'+location.locationId+'/status'
            debug(availabilityTopic)
            mqttClient.publish(availabilityTopic, 'offline')
        })
    }
    if (exitCode || exitCode === 0) debug('Exit code: '+exitCode)
    await utils.sleep(1)
    process.exit()
}

// Establich websocket connections and register/refresh location status on connect/disconnect
async function processLocations(locations) {
    ringLocations.forEach(async location => {
        const devices = await location.getDevices()
        const cameras = await location.cameras
        const availabilityTopic = ringTopic+'/'+location.locationId+'/status'
        if (!(subscribedLocations.includes(location.locationId))) {
            var alarmPublished = false
            subscribedLocations.push(location.locationId)
            if (devices && devices.length > 0 && utils.hasAlarm(devices)) {
                location.onConnected.subscribe(async connected => {
                    if (connected) {
                        debug('Location '+location.locationId+' is connected')
                        publishAlarm = true
                        publishLocation(devices, cameras, availabilityTopic)
                        alarmPublished = true
                    } else {
                        publishAlarm = false
                        mqttClient.publish(availabilityTopic, 'offline', { qos: 1 })
                        debug('Location '+location.locationId+' is disconnected')
                    }
                })
            }
            if (cameras && cameras.length > 0 && !alarmPublished) {
                publishLocation(devices, cameras, availabilityTopic)
            }
        } else {
            publishLocation(devices, cameras, availabilityTopic)
        }
    })
}

// Loop through locations to publish alarms/cameras
async function publishLocation(devices, cameras, availabilityTopic) {
    if (republishCount < 1) { republishCount = 1 }
    while (republishCount > 0 && mqttConnected) {
       try {
            if (devices && devices.length > 0 && utils.hasAlarm(devices) && publishAlarm) {
                devices.forEach((device) => {
                    publishAlarmDevice(device)
                })
            }
            if (cameras && cameras.length > 0) {
                publishCameras(cameras)
            }
            await utils.sleep(1)
            mqttClient.publish(availabilityTopic, 'online', { qos: 1 })
        } catch (error) {
                debug(error)
        }
    await utils.sleep(republishDelay)
    republishCount--
    }
}

// Return class information if supported Alarm device
function publishAlarmDevice(device) {
    const subscribedDevice = subscribedDevices.find(d => (d.deviceId == device.zid && d.locationId == device.location.locationId))
    var newDevice = undefined
    if (!subscribedDevice) {
        switch(device.deviceType) {
            case 'sensor.contact':
                newDevice = new ContactSensor(device, ringTopic)
                break;
            case 'sensor.motion':
                newDevice = new MotionSensor(device, ringTopic)
                break;
            case 'sensor.zone':
                newDevice = new ContactSensor(device, ringTopic)
                break;
            case 'alarm.smoke':
                newDevice = new SmokeAlarm(device, ringTopic)
                break;
            case 'alarm.co':
                newDevice = new CoAlarm(device, ringTopic)
                break;
            case 'listener.smoke-co':
                newDevice = new SmokeCoListener(device, ringTopic)
                break;
            case 'sensor.flood-freeze':
                newDevice = new FloodFreezeSensor(device, ringTopic)
                break;
            case 'security-panel':
                newDevice = new SecurityPanel(device, ringTopic)
                break;
            case 'switch':
                newDevice = new Switch(device, ringTopic)
                break;
            case 'switch.multilevel':
                if (device.data.categoryId === 17) {
                    newDevice = new Fan(device, ringTopics)
                } else {
                    newDevice = new MultiLevelSwitch(device, ringTopic)
                }
        }
    
        // Check if device is a lock	
        if (/^lock($|\.)/.test(device.data.deviceType)) {
            newDevice = new Lock(device, ringTopic)
        }
    }

    if (subscribedDevice) {
        debug('Republishing existing device id: '+subscribedDevice.deviceId)
        subscribedDevice.init(mqttClient)
    } else if (newDevice) {
        debug('Publishing new device id: '+newDevice.deviceId)
        newDevice.init(mqttClient)
        subscribedDevices.push(newDevice)
    } else {
        debug('!!! Found unsupported device type: '+device.deviceType+' !!!')
    }
}

// Publish all cameras for a given location
function publishCameras(cameras) {
    cameras.forEach(camera => {
        const subscribedDevice = subscribedDevices.find(d => (d.deviceId == camera.data.device_id && d.locationId == camera.data.location_id))
        if (subscribedDevice) {
            subscribedDevice.init(mqttClient)
        } else {
            newCamera = new Camera(camera, ringTopic)
            newCamera.init(mqttClient)
            subscribedDevices.push(newCamera)
        }
    })
}

// Process received MQTT command
async function processMqttMessage(topic, message) {
    var message = message.toString()
    if (topic === hassTopic) {
        // Republish devices and state after 60 seconds if restart of HA is detected
        debug('Home Assistant state topic '+topic+' received message: '+message)
        if (message == 'online') {
            debug('Resending device config/state in 30 seconds')
            // Make sure any existing republish dies
            republishCount = 0 
            await utils.sleep(republishDelay+5)
            // Reset republish counter and start publishing config/state
            republishCount = 10
            processLocations(ringLocations)
            debug('Resent device config/state information')
        }
    } else {
        var topic = topic.split('/')
        // Parse topic to get alarm/component/device info
        const locationId = topic[topic.length - 5]
        const component = topic[topic.length - 3]
        const deviceId = topic[topic.length - 2]
        const commandTopicLevel = topic[topic.length - 1]

        // Find existing device by matching deviceTopic and process command
        const cmdDevice = subscribedDevices.find(d => (d.deviceId == deviceId && d.locationId == locationId))
        if (cmdDevice) {
            cmdDevice.processCommand(message, commandTopicLevel, component)
        } else {
            debug('Received MQTT message for '+deviceTopic+' but could not find matching device')
        }
    }
}

function initMqtt() {
    const mqtt = mqttApi.connect({
        host:CONFIG.host,
        port:CONFIG.port,
        username: CONFIG.mqtt_user,
        password: CONFIG.mqtt_pass
    });
    return mqtt
}

/* End Functions */

// Main code loop
const main = async() => {
    let locationIds = null

    // Get Configuration from file
    try {
        CONFIG = require('./config')
        ringTopic = CONFIG.ring_topic ? CONFIG.ring_topic : 'ring'
        hassTopic = CONFIG.hass_topic
        if (!(CONFIG.location_ids === undefined || CONFIG.location_ids == 0)) {
            locationIds = CONFIG.location_ids
        }
    } catch (e) {
        try {
            debug('Configuration file not found, try environment variables!')
            CONFIG = {
                "host": process.env.MQTTHOST,
                "port": process.env.MQTTPORT,
                "ring_topic": process.env.MQTTRINGTOPIC,
                "hass_topic": process.env.MQTTHASSTOPIC,
                "mqtt_user": process.env.MQTTUSER,
                "mqtt_pass": process.env.MQTTPASSWORD,
                "ring_user": process.env.RINGUSER,
                "ring_pass": process.env.RINGPASS,
                "ring_token": process.env.RINGTOKEN,
            }
            ringTopic = CONFIG.ring_topic ? CONFIG.ring_topic : 'ring'
            hassTopic = CONFIG.hass_topic
            if (!(CONFIG.ring_user || CONFIG.ring_pass) && !CONFIG.ring_token) throw "Required environment variables are not set!"
        }
        catch (ex) {
            debug(ex)
            debug('Configuration file not found and required environment variables are not set!')
            process.exit(1)
        }
    }

    // Establish connection to Ring API
    try {
        let auth = {
            locationIds: locationIds
        }

        // Ring allows users to enable two-factor authentication. If this is
        // enabled, the user/pass authentication will not work.
        // See: https://github.com/dgreif/ring/wiki/Two-Factor-Auth
        if(CONFIG.ring_token) {
            auth["refreshToken"] = CONFIG.ring_token
        } else {
            auth["email"] = CONFIG.ring_user
            auth["password"] = CONFIG.ring_pass
        }
        
        auth["cameraStatusPollingSeconds"] = 20
        auth["cameraDingsPollingSeconds"] = 2

        const ring = new RingApi(auth)
        ringLocations = await ring.getLocations()
    } catch (error) {
        debug(error)
        debug( colors.red( 'Couldn\'t create the API instance. This could be because ring.com changed their API again' ))
        debug( colors.red( 'or maybe the password is wrong. Please check settings and try again.' ))
        process.exit(1)
    }

    // Initiate connection to MQTT broker
    try {
        mqttClient = await initMqtt()
        mqttConnected = true
        if (hassTopic) { mqttClient.subscribe(hassTopic) }
        debug('Connection established with MQTT broker, sending config/state information in 5 seconds.')
    } catch (error) {
        debug(error)
        debug( colors.red( 'Couldn\'t connect to MQTT broker. Please check the broker and configuration settings.' ))
        process.exit(1)
    }

    // On MQTT connect/reconnect send config/state information after delay
    mqttClient.on('connect', async function () {
        if (!mqttConnected) {
            mqttConnected = true
            debug('MQTT connection reestablished, resending config/state information in 5 seconds.')
        }
        await utils.sleep(5)
        processLocations(ringLocations)
    })

    mqttClient.on('reconnect', function () {
        if (mqttConnected) {
            debug('Connection to MQTT broker lost. Attempting to reconnect...')
        } else {
            debug('Attempting to reconnect to MQTT broker...')
        }
        mqttConnected = false
    })

    mqttClient.on('error', function (error) {
        debug('Unable to connect to MQTT broker.', error.message)
        mqttConnected = false
    })

    // Process MQTT messages from subscribed command topics
    mqttClient.on('message', async function (topic, message) {
        processMqttMessage(topic, message)
    })
}

// Call the main code
main()
