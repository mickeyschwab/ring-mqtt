#!/usr/bin/env node
'use strict'

// Defines
const RingApi = require('ring-client-api').RingApi
const mqttApi = require ('mqtt')
const debug = require('debug')('ring-mqtt')
const debugError = require('debug')('error')
const debugMqtt = require('debug')('mqtt')
const colors = require( 'colors/safe' )
var CONFIG
var ringTopic
var hassTopic
var mqttClient
var mqttConnected = false
var ringLocations = new Array()
var subscribedLocations = new Array()
var subscribedDevices = new Array()
var publishEnabled = true  // Flag to stop publish/republish if connection is down
var republishCount = 10 // Republish config/state this many times after startup or HA start/restart
var republishDelay = 30 // Seconds

// Setup Exit Handwlers
process.on('exit', processExit.bind(null, {cleanup:true, exit:true}))
process.on('SIGINT', processExit.bind(null, {cleanup:true, exit:true}))
process.on('SIGTERM', processExit.bind(null, {cleanup:true, exit:true}))
process.on('uncaughtException', processExit.bind(null, {exit:true}))

/* Functions */

// Simple sleep to pause in async functions
function sleep(sec) {
    return new Promise(res => setTimeout(res, sec*1000));
}

// Set unreachable status on exit 
async function processExit(options, exitCode) {
    if (options.cleanup) {
        ringLocations.forEach(async location => {
            const availabilityTopic = ringTopic+'/'+location.locationId+'/status'
            mqttClient.publish(availabilityTopic, 'offline')
        })
    }
    if (exitCode || exitCode === 0) debug('Exit code: '+exitCode)
    if (options.exit) {
        await sleep(1)
        process.exit()
    }
}

// Establich websocket connections and register/refresh location status on connect/disconnect
async function processLocations(locations) {
    ringLocations.forEach(async location => {
        const alarmDevices = await location.getDevices()
        if (!(subscribedLocations.includes(location.locationId))) {
            subscribedLocations.push(location.locationId)
            location.onConnected.subscribe(async connected => {
                const availabilityTopic = ringTopic+'/'+location.locationId+'/status'
                if (connected) {
                    debug('Location '+location.locationId+' is connected')
                    publishEnabled = true
                    mqttClient.publish(availabilityTopic, 'online', { qos: 1 })
                    publishDevices(location, alarmDevices)
                } else {
                    publishEnabled = false
                    mqttClient.publish(availabilityTopic, 'offline', { qos: 1 })
                    debug('Location '+location.locationId+' is disconnected')
                }
            })
        } else {
            publishDevices(location, alarmDevices)
        }
    })
}

// Publishes all found devices for a given location
// On startup/HASS restart message republish at 30 second interval for 10 cycles
async function publishDevices(location, alarmDevices) {
    // If republish cycle is complete then set to publish once
    if (republishCount < 1) { republishCount = 1 }
    while (republishCount > 0 && publishEnabled && mqttConnected) {
        // Publish if location has an alarm
        if (alarmDevices.filter(device => device.data.deviceType === 'security-panel')) publishAlarm(location, alarmDevices)
        // Publish if location has at least one camera
        if (location.cameras !== undefined && location.cameras.length > 0) publishCameras(location)
        await sleep(republishDelay)
        republishCount--
    }
}

// Return class information if supported alarm device
function supportedAlarmDevice(device) {
    switch(device.data.deviceType) {
        case 'sensor.contact':
            device.className = 'door'
            device.component = 'binary_sensor'
            break;
        case 'sensor.motion':
            device.className = 'motion'
            device.component = 'binary_sensor'
            break;
        case 'alarm.smoke':
            device.className = 'smoke' 
            device.component = 'binary_sensor'
            break;
        case 'alarm.co':
            device.className = 'gas'
            device.component = 'binary_sensor'
            break;
        case 'listener.smoke-co':
            device.classNames = [ 'smoke', 'gas' ]
            device.suffixNames = [ 'Smoke', 'CO' ]
            device.component = 'binary_sensor'
            break;
        case 'sensor.flood-freeze':
            device.classNames = [ 'moisture', 'cold' ]
            device.suffixNames = [ 'Flood', 'Freeze' ]
            device.component = 'binary_sensor'
            break;
        case 'security-panel':
            device.component = 'alarm_control_panel'
            device.command = true
            break;
    }
    
    // Check if device is a lock	
    if (/^lock($|\.)/.test(device.data.deviceType)) {
        device.component = 'lock'
        device.command = true
    }
}

// Returns battery percent or estimate percent if device does not provide specific percent
function getAlarmDeviceBatteryLevel(device) {
    if (device.batteryLevel !== undefined) {
        // Return 100% if 99% reported, otherwise return reported battery level
        return (device.batteryLevel === 99) ? 100 : device.batteryLevel
    } else if (device.batteryStatus === 'full') {
        return 100
    } else if (device.batteryStatus === 'ok') {
        return 50
    } else if (device.batteryStatus === 'none') {
        return 'none'
    }
    return 0
}

// Publish all supported alarm devices for location
async function publishAlarm(location, devices) {
    try {
        const availabilityTopic = ringTopic+'/'+location.locationId+'/status'
        devices.forEach((device) => {
            supportedAlarmDevice(device)
            if (device.component) {
                publishAlarmDevice(device)
            }
        })
        await sleep(1)
        mqttClient.publish(availabilityTopic, 'online', { qos: 1 })
    } catch (error) {
        debugError(error)
    }
}

// Register all device sensors via HomeAssistant MQTT Discovery and
// subscribe to command topic if device accepts commands
async function publishAlarmDevice(device) {
    const locationId = device.location.locationId
    const numSensors = (!device.classNames) ? 1 : device.classNames.length

    // Build alarm, availability and device topic
    const alarmTopic = ringTopic+'/'+locationId+'/alarm'
    const availabilityTopic = ringTopic+'/'+locationId+'/status'
    const deviceTopic = alarmTopic+'/'+device.component+'/'+device.zid

    // Loop through device sensors and publish HA discovery configuration
    for(let i=0; i < numSensors; i++) {
        // If device has more than one sensor component create suffixes
        // to build unique device entries for each sensor
        if (numSensors > 1) {
            var className = device.classNames[i]
            var deviceName = device.name+' '+device.suffixNames[i]
            var sensorId = device.zid+'_'+className
            var sensorTopic = deviceTopic+'/'+className
        } else {
            var className = device.className
            var deviceName = device.name
            var sensorId = device.zid
            var sensorTopic = deviceTopic
        }

        // Build state topic and HASS MQTT discovery topic
        const stateTopic = sensorTopic+'/state'
        const attributesTopic = deviceTopic+'/attributes'
        const configTopic = 'homeassistant/'+device.component+'/'+locationId+'/'+sensorId+'/config'
    
        // Build the MQTT discovery message
        const message = { 
            name: deviceName,
            unique_id: sensorId,
            availability_topic: availabilityTopic,
            payload_available: 'online',
            payload_not_available: 'offline',
            state_topic: stateTopic,
            json_attributes_topic: attributesTopic
        }

        // If device supports commands then
        // build command topic and subscribe for updates
        if (device.command) {
            const commandTopic = sensorTopic+'/command'
            message.command_topic = commandTopic
            mqttClient.subscribe(commandTopic)
        }

        // If binary sensor include device class to help set icons in UI 
        if (className) {
            message.device_class = className
        }

        debug('HASS config topic: '+configTopic)
        debug(message)
        mqttClient.publish(configTopic, JSON.stringify(message), { qos: 1 })
    }
    // Give Home Assistant time to configure device before sending first state data
    await sleep(2)

    // Publish device state and subscribe to updates if new device
    if (subscribedDevices.find(subscribedDevice => subscribedDevice.zid === device.zid)) {
        publishAlarmDeviceState(device.data, deviceTopic)
    } else {
        device.onData.subscribe(data => {
            publishAlarmDeviceState(data, deviceTopic)
        })
        subscribedDevices.push(device)
    }
}

// Publish state data for alarm devices
function publishAlarmDeviceState(data, deviceTopic) {
    var deviceState = undefined
    switch(data.deviceType) {
        case 'sensor.contact':
        case 'sensor.motion':
            var deviceState = data.faulted ? 'ON' : 'OFF'
            break;
        case 'alarm.smoke':
        case 'alarm.co':
            var deviceState = data.alarmStatus === 'active' ? 'ON' : 'OFF' 
            break;
        case 'listener.smoke-co':
            const coAlarmState = data.co && data.co.alarmStatus === 'active' ? 'ON' : 'OFF'
            const smokeAlarmState = data.smoke && data.smoke.alarmStatus === 'active' ? 'ON' : 'OFF'
            publishMqttState(deviceTopic+'/gas/state', coAlarmState)
            publishMqttState(deviceTopic+'/smoke/state', smokeAlarmState)
            break;
        case 'sensor.flood-freeze':
            const floodAlarmState = data.flood && data.flood.faulted ? 'ON' : 'OFF'
            const freezeAlarmState = data.freeze && data.freeze.faulted ? 'ON' : 'OFF'
            publishMqttState(deviceTopic+'/moisture/state', floodAlarmState)
            publishMqttState(deviceTopic+'/cold/state', freezeAlarmState)
            break;                
        case 'security-panel':
            switch(data.mode) {
                case 'none':
                    deviceState = 'disarmed'
                    break;
                case 'some':
                    deviceState = 'armed_home'
                    break;
                case 'all':
                    deviceState = 'armed_away'
                    break;
                default:
                    deviceState = 'unknown'
            }
            break;
    }

    if (/^lock($|\.)/.test(data.deviceType)) {
       switch(data.locked) {
            case 'locked':
                deviceState = 'LOCK'
                break;
            case 'unlocked':
                deviceState = 'UNLOCK'
                break;
            default:
                deviceState = 'UNKNOWN'
        }
    }

    if (deviceState !== undefined) {
        publishMqttState(deviceTopic+'/state', deviceState)
    }

    // Publish any available device attributes (battery, power, etc)
    const attributes = {}
    const batteryLevel = getAlarmDeviceBatteryLevel(data)
    if (batteryLevel !== 'none') {
        attributes.battery_level = batteryLevel
    }
    if (data.tamperStatus) {
        attributes.tamper_status = data.tamperStatus
    }
    publishMqttState(deviceTopic+'/attributes', JSON.stringify(attributes))
}

// Publish all cameras for a given location
function publishCameras(location) {
    const cameras = location.cameras
    cameras.forEach(camera => {
        publishCamera(location, camera)
    })
}

// Register all camera functions via HomeAssistant MQTT Discovery
// and subscribe to command topic if function accepts commands (lights, siren)
async function publishCamera(location, camera) {
    const cameraTopic = ringTopic+'/'+location.locationId+'/camera/'+camera.id

    // Publish motion sensor feature for camera
    var cameraFunction = {
        type: 'motion',
        component: 'binary_sensor',
        className: 'motion',
        suffix: 'Motion',
        hasCommand: false
    }
    if (!camera.motion) {
        camera.motion = {
            active_ding: false,
            ding_duration: 180,
            last_ding: 0,
            last_ding_expires: 0
        }
    }
    publishCameraFunction(location, camera, cameraTopic, cameraFunction)

    // If camera is also a doorbell publish the doorbell sensor
    if (camera.isDoorbot) {
        cameraFunction = {
            type: 'ding',
            component: 'binary_sensor',
            className: 'occupancy',
            suffix: 'Ding',
            hasCommand: false
        }
        if (!camera.ding) {
            camera.ding = {
                active_ding: false,
                ding_duration: 180,
                last_ding: 0,
                last_ding_expires: 0
            }
        }
        publishCameraFunction(location, camera, cameraTopic, cameraFunction)
    }
    
    // If camera has a light publish light component
    if (camera.hasLight) {
       cameraFunction = {
            type: 'light',
            component: 'light',
            suffix: 'Light',
            hasCommand: true
        }
        publishCameraFunction(location, camera, cameraTopic, cameraFunction)
        camera.prev_led_status = "unknown"
    }

    // If camera has a siren publish switch component
    if (camera.hasSiren) {
       cameraFunction = {
            type: 'siren',
            component: 'switch',
            suffix: 'Siren',
            hasCommand: true
        }
        publishCameraFunction(location, camera, cameraTopic, cameraFunction)
        camera.prev_siren_status = "unknown"
    }

    // Give Home Assistant time to configure device before sending first state data
    await sleep(2)

    // Publish device state and, if new device, subscribe for state updates
    publishDingState(camera, cameraTopic)
    if (!camera.hasOwnProperty('subscribed')) {
        // Subscribe to Ding events (all cameras have at least motion events)
        camera.onNewDing.subscribe(ding => {
            publishDingState(camera, cameraTopic, ding)
        })
        // Subscribe to data updates (only updates at poll interval, default every 20 seconds)
        camera.onData.subscribe(data => {
            publishCameraDevices(camera, cameraTopic)
        })
        camera.subscribed = true
    } else {
        publishCameraDevices(camera, cameraTopic)
    } 
}

// Build and publish a Home Assistant MQTT discovery packet for camera feature
async function publishCameraFunction(location, camera, cameraTopic, cameraFunction) {
    const availabilityTopic = ringTopic+'/'+location.locationId+'/status'
    const componentTopic = cameraTopic+'/'+cameraFunction.type
    const configTopic = 'homeassistant/'+cameraFunction.component+'/'+location.locationId+'/'+camera.id+'_'+cameraFunction.type+'/config'
    const message = {
        name: camera.name+' '+cameraFunction.suffix,
        unique_id: camera.id+'_'+cameraFunction.type,
        availability_topic: availabilityTopic,
        payload_available: 'online',
        payload_not_available: 'offline',
        state_topic: componentTopic+'/state'
    }

    if (cameraFunction.className) { message.device_class = cameraFunction.className }

    if (cameraFunction.hasCommand) {
        const commandTopic = componentTopic+'/command'
        message.command_topic = commandTopic
        mqttClient.subscribe(commandTopic)
    }
        
    debug('HASS config topic: '+configTopic)
    debug(message)
    mqttClient.publish(configTopic, JSON.stringify(message), { qos: 1 })
}

// Process a ding event from camera or publish existing ding state
async function publishDingState(camera, cameraTopic, ding) {
    // Is it an active ding?
    if (ding) {
        // Is it a motion or doorbell ding?
        const dingType = ding.kind
        const stateTopic = cameraTopic+'/'+dingType+'/state'

        // Store new ding info in camera properties
        camera[dingType].last_ding = Math.floor(ding.now)
        camera[dingType].ding_duration = ding.expires_in
        camera[dingType].last_ding_expires = camera[dingType].last_ding+ding.expires_in
        debug('Ding of type '+dingType+' received at '+ding.now+' from camera '+camera.id)

        // Publish MQTT active sensor state
        // Will republish to MQTT for new dings even if ding is already active
        publishMqttState(stateTopic, 'ON')

        // If ding was not already active, set active ding state property
        // and begin sleep until expire time.
        if (!camera[dingType].active_ding) {
            camera[dingType].active_ding = true
            // Sleep until ding expires, new dings on same device will increase expire
            // time so code below will loop, check new expire time, and sleep again
            // until all dings expire
            while (Math.floor(Date.now()/1000) < camera[dingType].last_ding_expires) { 
                const sleeptime = (camera[dingType].last_ding_expires - Math.floor(Date.now()/1000)) + 1
                debug('Ding of type '+dingType+' from camera '+camera.id+' expires in '+sleeptime)
                await sleep(sleeptime)
                debug('Ding of type '+dingType+' from camera '+camera.id+' exired')
            }
            // All dings have expired, set state back to false/off
            debug('All dings of type '+dingType+' from camera '+camera.id+' have expired')
            camera[dingType].active_ding = false
            publishMqttState(stateTopic, 'OFF')
        }
    } else {
        // Not an active ding so just publish existing sensor state
        let dingType = 'motion'
        let stateTopic = cameraTopic+'/'+dingType+'/state'
        publishMqttState(stateTopic, (camera[dingType].active_ding ? 'ON' : 'OFF'))
        if (camera.isDoorbot) {
            dingType = 'ding'
            stateTopic = cameraTopic+'/'+dingType+'/state'
            publishMqttState(stateTopic, (camera[dingType].active_ding ? 'ON' : 'OFF'))
        }
    }
}

// Publish camera state for polled attributes (light/siren state, etc)
// Writes state to custom property to keep from publishing state except
// when values change from previous polling interval
async function publishCameraDevices(camera, cameraTopic) {
    if (camera.hasLight) {
        const stateTopic = cameraTopic+'/light/state'
        if (camera.data.led_status !== camera.prev_led_status) { 
            publishMqttState(stateTopic, (camera.data.led_status === 'on' ? 'ON' : 'OFF'))
            camera.prev_led_status = camera.data.led_status
        }
    }
    if (camera.hasSiren) {
        const stateTopic = cameraTopic+'/siren/state'
        const sirenStatus = camera.data.siren_status.seconds_remaining > 0 ? 'ON' : 'OFF'
        if (sirenStatus.toLowerCase() !== camera.prev_siren_status) {
            publishMqttState(stateTopic, sirenStatus)
            camera.prev_siren_status = sirenStatus.toLowerCase()
        }
    }
}

// Simple function to publish MQTT state messages with debug
function publishMqttState(topic, message) {
    debug(topic, message)
    mqttClient.publish(topic, message, { qos: 1 })
}

async function trySetAlarmMode(location, deviceId, message, delay) {
    // Pause before attempting to set alarm mode -- used for retries
    await sleep(delay)
    var alarmTargetMode
    debug('Set alarm mode: '+message)
    switch(message) {
        case 'DISARM':
            location.disarm();
            alarmTargetMode = 'none'
            break
        case 'ARM_HOME':
            location.armHome()
            alarmTargetMode = 'some'
            break
        case 'ARM_AWAY':
            location.armAway()
            alarmTargetMode = 'all'
            break
        default:
            debug('Cannot set alarm mode: Unknown')
            return 'unknown'
    }
    // Sleep a few seconds and check if alarm entered requested mode
    await sleep(2);
    const devices = await location.getDevices()
    const device = await devices.find(device => device.data.zid === deviceId)
    if (device.data.mode == alarmTargetMode) {
        debug('Alarm successfully entered mode: '+message)
        return true
    } else {
        debug('Device failed to enter requested arm/disarm mode!')
        return false
    }
}

// Set Alarm Mode on received MQTT command message
async function setAlarmMode(location, deviceId, message) {
    debug('Received set alarm mode '+message+' for Security Panel Id: '+deviceId)
    debug('Location Id: '+ location.locationId)

    // Try to set alarm mode and retry after delay if mode set fails
    // Initial attempt with no delay
    var delay = 0
    var retries = 12
    var setAlarmSuccess = false
    while (retries-- > 0 && !(setAlarmSuccess)) {
        setAlarmSuccess = await trySetAlarmMode(location, deviceId, message, delay)
        // On failure delay 10 seconds for next set attempt
        delay = 10
    }
    // Check the return status and print some debugging for failed states
    if (setAlarmSuccess == false ) {
        debug('Device could not enter proper arming mode after all retries...Giving up!')
    } else if (setAlarmSuccess == 'unknown') {
        debug('Ignoring unknown command.')
    }
}

// Set lock target state on received MQTT command message
async function setLockTargetState(location, deviceId, message) {
    debug('Received set lock state '+message+' for lock Id: '+deviceId)
    debug('Location Id: '+ location.locationId)
    
    const command = message.toLowerCase()

    switch(command) {
        case 'lock':
        case 'unlock':
            const devices = await location.getDevices();
            const device = devices.find(device => device.id === deviceId);
            if(!device) {
                debug('Cannot find specified device id in location devices');
                break;
            }
            device.sendCommand(`lock.${command}`);
            break;
        default:
            debug('Received invalid command for lock!')
    }
}

// Process received MQTT command
async function processMqttCommand(topic, message) {
    var message = message.toString()

    if (topic === hassTopic) {
        // Republish devices and state after 60 seconds if restart of HA is detected
        debug('Home Assistant state topic '+topic+' received message: '+message)
        if (message == 'online') {
            debug('Resending device config/state in 30 seconds')
            // Make sure any existing republish dies
            republishCount = 0 
            await sleep(republishDelay+5)
            // Reset republish counter and start publishing config/state
            republishCount = 10
            processLocations(ringLocations)
            debug('Resent device config/state information')
        }
    } else {
        var topic = topic.split('/')
        const ringDevType = topic[topic.length - 4]
        const locationId = topic[topic.length - 5]

        // Get alarm by location ID
        const location = await ringLocations.find(location => location.locationId == locationId)

        if (ringDevType === 'alarm') {
            const deviceId = topic[topic.length - 2]
            const component = topic[topic.length - 3]
            switch(component) {
                case 'alarm_control_panel':
                    setAlarmMode(location, deviceId, message)
                    break;
                case 'lock':
                    setLockTargetState(location, deviceId, message)
                    break;
                default:
                    debug('Somehow received command for an unknown alarm device!')
            }
        } else if (ringDevType == 'camera') {
            const cameraFunctionType = topic[topic.length - 2]
            const cameraId = topic[topic.length - 3]
            switch (cameraFunctionType) {
                case 'light':
                    setCameraLight(location, cameraId, message)
                    break;
                case 'siren':
                    setCameraSiren(location, cameraId, message)
                    break
                default:
                    debug('Somehow received command for an unknown camera device!')
            }
        } else {
            debug('Could not determine ring device associated with command')
        }
    }
}

// Set camera light on/off
async function setCameraLight(location, cameraId, message) {
    const camera = location.cameras.find(camera => camera.id == cameraId)
    switch (message) {
        case 'ON':
            camera.setLight(true)
            break;
        case 'OFF':
            camera.setLight(false)
            break;
        default:
            debug('Received unkonw command for light on camera ID '+camera.id)
    }
}

// Set camera siren on/off
async function setCameraSiren(location, cameraId, message) {
    const camera = location.cameras.find(camera => camera.id == cameraId)
    switch (message) {
        case 'ON':
            camera.setSiren(true)
            break;
        case 'OFF':
            camera.setSiren(false)
            break;
        default:
            debug('Received unkonw command for siren on camera ID '+camera.id)
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
            debugError('Configuration file not found, try environment variables!')
            CONFIG = {
                "host": process.env.MQTTHOST,
                "port": process.env.MQTTPORT,
                "ring_topic": process.env.MQTTRINGTOPIC,
                "hass_topic": process.env.MQTTHASSTOPIC,
                "mqtt_user": process.env.MQTTUSER,
                "mqtt_pass": process.env.MQTTPASSWORD,
                "ring_user": process.env.RINGUSER,
                "ring_pass": process.env.RINGPASS
            }
            ringTopic = CONFIG.ring_topic ? CONFIG.ring_topic : 'ring'
            hassTopic = CONFIG.hass_topic
            if (!(CONFIG.ring_user || CONFIG.ring_pass)) throw "Required environment variables are not set!"
        }
        catch (ex) {
            debugError(ex)
            console.error('Configuration file not found and required environment variables are not set!')
            process.exit(1)
        }
    }

    // Establish connection to Ring API
    try {
        const ringApi = new RingApi({
            email: CONFIG.ring_user,
            password: CONFIG.ring_pass,
            cameraStatusPollingSeconds: 20,
            cameraDingsPollingSeconds: 2
        })
        ringLocations = await ringApi.getLocations()
    } catch (error) {
        debugError(error)
        debugError( colors.red( 'Couldn\'t create the API instance. This could be because ring.com changed their API again' ))
        debugError( colors.red( 'or maybe the password is wrong. Please check settings and try again.' ))
        process.exit(1)
    }

    // Initiate connection to MQTT broker
    try {
        mqttClient = await initMqtt()
        mqttConnected = true
        if (hassTopic) { mqttClient.subscribe(hassTopic) }
        debugMqtt('Connection established with MQTT broker, sending config/state information in 5 seconds.')
    } catch (error) {
        debugError(error)
        debugError( colors.red( 'Couldn\'t connect to MQTT broker. Please check the broker and configuration settings.' ))
        process.exit(1)
    }

    // On MQTT connect/reconnect send config/state information after delay
    mqttClient.on('connect', async function () {
        if (!mqttConnected) {
            mqttConnected = true
            debugMqtt('MQTT connection reestablished, resending config/state information in 5 seconds.')
        }
        await sleep(5)
        processLocations(ringLocations)
    })

    mqttClient.on('reconnect', function () {
        if (mqttConnected) {
            debugMqtt('Connection to MQTT broker lost. Attempting to reconnect...')
        } else {
            debugMqtt('Attempting to reconnect to MQTT broker...')
        }
        mqttConnected = false
    })

    mqttClient.on('error', function (error) {
        debugMqtt('Unable to connect to MQTT broker.', error.message)
        mqttConnected = false
    })

    // Process MQTT messages from subscribed command topics
    mqttClient.on('message', async function (topic, message) {
        processMqttCommand(topic, message)
    })
}

// Call the main code
main()
