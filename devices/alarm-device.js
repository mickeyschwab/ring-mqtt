const debug = require('debug')('ring-mqtt')
const colors = require( 'colors/safe' )

class AlarmDevice {
    constructor(device, ringTopic) {
        this.device = device

        // Set device location and top level MQTT topics 
        this.locationId = this.device.location.locationId
        this.deviceId = this.device.zid
        this.alarmTopic = ringTopic+'/'+this.locationId+'/alarm'
        this.availabilityTopic = ringTopic+'/'+this.locationId+'/status'
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
}

module.exports = AlarmDevice
