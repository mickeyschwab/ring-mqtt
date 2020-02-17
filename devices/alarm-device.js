const debug = require('debug')('ring-mqtt')
const colors = require('colors/safe')
const utils = require('../lib/utils')

class AlarmDevice {
    constructor(device, ringTopic) {
        this.device = device

        // Set device location and top level MQTT topics 
        this.locationId = this.device.location.locationId
        this.deviceId = this.device.zid
        this.alarmTopic = ringTopic+'/'+this.locationId+'/alarm'
        this.availabilityState = 'offline'
    }

    // Return batterylevel or convert battery status to estimated level
    getBatteryLevel() {
        if (this.device.data.batteryLevel !== undefined) {
            // Return 100% if 99% reported, otherwise return reported battery level
            return (this.device.data.batteryLevel === 99) ? 100 : this.device.batteryLevel
        } else if (this.device.data.batteryStatus === 'full') {
            return 100
        } else if (this.device.data.batteryStatus === 'ok') {
            return 50
        } else if (this.device.data.batteryStatus === 'none') {
            return 'none'
        }
        return 0
    }

    // Publish raw MQTT message without debug
    mqttPublish(mqttClient, topic, message) {
        mqttClient.publish(topic, message, { qos: 1 })
    }

    // Publish state messages with debug
    publishState(mqttClient, topic, state) {
        debug(topic, state)
        this.mqttPublish(mqttClient, topic, state)
    }

    // Publish device state data and subscribe to
    // device events if not previously subscribed
    publishSubscribeDevice(mqttClient) {
        if (this.subscribed) {
            this.publishData(mqttClient)
        } else {
            this.device.onData.subscribe(data => {
                this.publishData(mqttClient)
            })
            this.subscribed = true
        }
        // Publish availability state for device
        this.online(mqttClient)
    }

    // Publish device attributes
    publishAttributes(mqttClient) {
        const attributes = {}
        const batteryLevel = this.getBatteryLevel()
        if (batteryLevel !== 'none') {
            attributes.battery_level = batteryLevel
        }
        if (this.device.data.tamperStatus) {
            attributes.tamper_status = this.device.data.tamperStatus
        }
        debug(this.attributesTopic, attributes)
        this.mqttPublish(mqttClient, this.attributesTopic, JSON.stringify(attributes))
    }

    // Set state topic online
    async online(mqttClient) {
        await utils.sleep(1)
        this.availabilityState = 'online'
        this.publishState(mqttClient, this.availabilityTopic, this.availabilityState)
    }

    // Set state topic offline
    offline(mqttClient) {
        this.availabilityState = 'offline'
        this.publishState(mqttClient, this.availabilityTopic, this.availabilityState)
    }

}

module.exports = AlarmDevice
