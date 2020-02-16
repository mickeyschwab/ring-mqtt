const debug = require('debug')('ring-mqtt')
const colors = require('colors/safe')

class Utils
{

    // Simple sleep function for various required delays
    sleep(sec) {
        return new Promise(res => setTimeout(res, sec*1000))
    }

    // Set unreachable status on exit
    async processExit(options, exitCode, ringLocations, mqttClient) {
        if (options.cleanup) {
            ringLocations.forEach(async location => {
                availabilityTopic = ringTopic+'/'+location.locationId+'/status'
                mqttClient.publish(availabilityTopic, 'offline')
            })
        }
        if (exitCode || exitCode === 0) debug('Exit code: '+exitCode)
        await new Promise(res => setTimeout(res, 1000))
        if (options.exit) {
            process.exit()
        }
    }

    // Check if location has alarm panel (could be only camera/lights)
    hasAlarm(devices) {
        if (devices.filter(device => device.data.deviceType === 'security-panel')) {
            return true
        }
        return false
    }

}

module.exports = new Utils()
