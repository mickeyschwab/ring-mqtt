# ring-mqtt
This script leverages the ring alarm API available at [dgreif/ring-alarm](https://github.com/dgreif/ring-alarm) and provides access to the alarm control panel, sensors, cameras and some 3rd party devices via MQTT.  It provides support for Home Assistant style MQTT discovery which allows for simple integration with Home Assistant with near zero configuration (assuming MQTT is already configured).  It can also be used with any other tool capable of working with MQTT as it provides consistent topic naming based on location/device ID.

**--- Breaking changes in v2.0 ---**
Due to changes in Home Assistant 0.104 I decided to change the lock MQTT state value from LOCK/UNLOCK to LOCKED/UNLOCKED to match the new default starting in this version.  If you are using and older version of Home Assistant, please continue to use prior versions of this script.  If you are using this script with other tools, such as Node Red, please make the required changes for monitoring the new state values.

**--- Breaking changes in v3.0 ---**
The 3.0 release is a major refactor with the goal to dramatically simplfy the ability to add support for new devices and reduce complexity in main code by standardizing devices functions.  Each device is now defined in it's own class, stored in separate files, and this class implements a maximum of two public methods, one for initializing a the device and a second for processing commands (only for devices that accept commands).  While this creates some code redundancy, it eliminates lots of ugly conditions and switch commands that were previously far too easy to break when adding new devices.

### Standard Installation (Linux)
Make sure Node.js (tested with 10.16.x and higher) is installed on your system and then clone this repo:

`git clone https://github.com/tsightler/ring-mqtt.git`

Change to the ring-mqtt directory and run:

```
chmod +x ring-mqtt.js
npm install
```

This will install all required dependencies.  Edit the config.js and enter your Ring account user/password and MQTT broker connection information.  You can also change the top level topic used for creating ring device topics as well as the Home Assistant state topic, but most people should leave these as default.

### Starting the service automatically during boot
I've included a sample service file which you can use to automaticlly start the script during system boot as long as your system uses systemd (most modern Linux distros).  The service file assumes you've installed the script in /opt/ring-mqtt and that you want to run the process as the homeassistant user, but you can easily modify this to any path and user you'd like.  Just edit the file as required and drop it in /lib/systemd/system then run the following:

```
systemctl daemon-reload
systemctl enable ring-mqtt
systemctl start ring-mqtt
```

### Docker Installation

To build, execute

```
docker build -t ring-mqtt/ring-mqtt .
```

To run, execute

```
docker run  -e "MQTTHOST={host name}" -e "MQTTPORT={host port}" -e "MQTTRINGTOPIC={host ring topic}" -e "MQTTHASSTOPIC={host hass topic}" -e "MQTTUSER={mqtt user}" -e "MQTTPASSWORD={mqtt pw}" -e "RINGUSER={ring user}" -e "RINGPASS={ring pq}" ring-mqtt/ring-mqtt
```

### Authentication Options
The script supports standard Ring username/password authentication, but can also be used with accounts with Two Factor Authenticaton, i.e. 2FA, enabled as well.  To use 2FA instead you must acquire a token for your Ring account by using ring-auth-cli from the command line and entering you username/password and then the passcode sent via SMS to your device.  Once you receive this token you can set the "ring_token" environment in the config.json file and leave "ring_user" and "ring_pass" blank.  For more details please check the [Two Factor Auth](https://github.com/dgreif/ring/wiki/Two-Factor-Auth) documentation from the ring client API.

Note that using 2FA authenticaiton this way opens up the possibility that, if your Home Assistant environment is comporomised, an attacker can acquire the token and use this to authenticate to your Ring account without even knowing your username/password and completely bypassing all 2FA protection on your account.  Please secure your Home Assistant environment carefully.

Personally, I think it's better to simply create a second account on Ring, dedicated for Home Assistant, and set a very strong password on this account.  This way, you can still have 2FA enabled on your primary account, while using this second account only for this script, allowing you to control exactly what devices are visible to HA directly in the Ring app by sharing only the specific devices.  Also, any action performed by Home Assistant will show up as being performed by this second account vs the primary account allowing for much easier auditing for nafarious activity.

While I believe this second approach is better, there was simply too much demand for 2FA support in the script, so I've included it, but, in any case, please secure your environment carefully.

### Config Options
By default, this script will discover and monitor alarms across all locations, even shared locations for which you have permissions, however, it is possible to limit the locations monitored by the script including specific location IDs in the config as follows:

```"location_ids": ["loc-id", "loc-id2"]```.

To get the location id from the ring website simply login to [Ring.com](https://ring.com/users/sign_in) and look at the address bar in the browser. It will look similar to ```https://app.ring.com/location/{location_id}``` with the last path element being the location id.

Now you should just execute the script and devices should show up automatically in Home Assistant within a few seconds.

### Optional Home Assistant Configuration (Highly Recommended)
If you'd like to take full advantage of the Home Assistant specific features (auto MQTT discovery and server state monitorting) you need to make sure Home Assistant MQTT is configured with discovery and birth message options, here's an example:
```
mqtt:
  broker: 127.0.0.1
  discovery: true
  discovery_prefix: homeassistant
  birth_message:
    topic: 'hass/status'
    payload: 'online'
    qos: 0
    retain: false
```

Contact sensors have a default device class of `door`. Adding `window` to the contact sensor name will change the device class to `window`.

### Using with MQTT tools other than Home Assistant (ex: Node Red)

MQTT topics are built consistently during each startup.  The easiest way to determine the device topics is to run the script with debug output as noted below and it will dump the state and command topics for all devices, the general format for topics is as follows:

```
ring/<location_id>/alarm/<ha_platform_type>/<device_id>/state
```

For alarm devices with mulitple functions the state or command topics are prefixed with the sensor class/type.  For example for the Smoke/CO Listener:

```
ring/<location_id>/alarm/<ha_platform_type>/<device_id>/gas_state
ring/<location_id>/alarm/<ha_platform_type>/<device_id>/co_state

```

Or for a multi-level switch:
```
ring/<location_id>/alarm/<ha_platform_type>/<device_id>/state               <-- For on/off state
ring/<location_id>/alarm/<ha_platform_type>/<device_id>/brightness_state    <-- For brightness state
ring/<location_id>/alarm/<ha_platform_type>/<device_id>/command             <-- Set on/off state
ring/<location_id>/alarm/<ha_platform_type>/<device_id>/brightness_command  <-- Set brightness state

```

For cameras the overall structure is the same:
```
ring/<location_id>/camera/binary_sensor/<device_id>/ding_state      <-- Doorbell state
ring/<location_id>/camera/binary_sensor/<device_id>/motion_state    <-- Motion state
ring/<location_id>/camera/light/<device_id>/state                   <-- Light on/off state
ring/<location_id>/camera/light/<device_id>/command                 <-- Set light on/off state
ring/<location_id>/camera/switch/<device_id>/state                  <-- Siren state
ring/<location_id>/camera/switch/<device_id>/command                <-- Set siren state
```

### Working with Homekit via Home Assistant
If you are attempting to use the HomeKit integration of Home Assistant to forward entities to Apple HomeKit you may need to implement a delay of the HomeKit service using an automation, although this may be addressed with the entity changes in HA 0.104 and later.  In prior versions the HomeKit service only exports devices available on service startup and the Ring devices will not be present until autodiscovery is complete.  This is documented in the HomeKit documentation for similar behavior of Z-wave devices and you can use a similar concept as [documented there](https://www.home-assistant.io/integrations/homekit/).  While there are several exampls such as waiting on specific devices, I think the easiest and most reliable is just a simple delay so I've reproduced that example below to start the HomeKit service after 2 minutes:

```yaml
# Example using a delay after the start of Home Assistant
homekit:
  auto_start: false

automation:
  - alias: 'Start HomeKit'
    trigger:
      - platform: homeassistant
        event: start
    action:
      - delay: 00:02  # Waits 2 minutes
      - service: homekit.start
```

### Current Features
- Simple configuration via config file, most cases just need Ring user/password and that's it
- Supports the following devices:
  - Alarm Devices
    - Ring Contact and Motion Sensors
    - Ring Flood/Freeze Sensor
    - Ring Smoke/CO Listener
    - First Alert Z-Wave Smoke/CO Detector
	- Ring Retro Kit Zones
    - Ring integrated door locks (status and lock control)
    - 3rd party Z-Wave swtiches, dimmers, and fans
  - Camera Devices
    - Motion Events
    - Doorbell (Ding) Events
    - Lights (for devices with lights)
    - Siren (for devices with siren support)
- Provides battery and tamper status for supported Alarm devices via JSON attribute topic (visible in Home Assistant UI)
- Full Home Assistant MQTT Discovery - devices appear automatically
- Consistent topic creation based on location/device ID - easy to use with MQTT tools like Node-RED
- Arm/Disarm via alarm control panel MQTT object
- Arm/Disarm commands are monitored for success and retried (default up to 12x with 10 second interval)
- Support for mulitple alarms
- Monitors websocket connection to each alarm and sets reachability status if socket is unavailable (Home Assistant UI reports "unknown" status for unreachable), automatically resends device state when connection is established
- Can monitor Home Assistant MQTT birth message to trigger automatic resend of configuration data after restart.  The script will automatically resend device config/state 60 seconds after receiving online message from Home Assistant.  This keeps you from having to restart the script after a Home Assistant restart.
- Monitors MQTT connection and automatically resends device state after any disconnect/reconnect event
- Does not require MQTT retain and can work well with brokers that provide no persistent storage

### Planned features
- Support for Ring smart lighting
- Support for additional 3rd party sensors/devices

### Possible future features
- Additional Devices (base station, keypad - at least for tamper/battery status)
- Base station settings (volume, chime)
- Arm/Disarm with code
- Arm/Disarm with sensor bypass
- Dynamic add/remove of alarms/devices (i.e. no service restart required)

### Debugging
By default the script should produce no console output, however, the script does leverage the terriffic [debug](https://www.npmjs.com/package/debug) package.  To get debug output, simply run the script like this:

**Debug messages from all modules** (Warning, this very verbose!)
```
DEBUG=* ./ring-mqtt.js
````

**Debug messages from ring-mqtt only**
```
DEBUG=ring-mqtt ./ring-mqtt.js
```
This option is also useful when using the script with external MQTT tools as it dumps all discovered sensors and their topics.  Also allows you to monitor sensor states in real-time on the console.

### Thanks
Many thanks to @dgrief and his excellent [ring-client-api API](https://github.com/dgreif/ring/) as well as his homebridge plugin, from which I've learned a lot.  Without his work it would have taken far more effort and time, probably more time than I had, to get this working.

Also thanks to [acolytec3](https://community.home-assistant.io/u/acolytec3) on the Home Assistant community forums for his original Ring Alarm MQTT script.  Having an already functioning script with support for MQTT discovery saved me quite a bit of time in developing this script.

