var request = require("request");
var types;
var Service, Characteristic;

module.exports = function(homebridge) {
  types = homebridge.hapLegacyTypes;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory("homebridge-liftmaster", "LiftMaster", LiftMasterAccessory);
}

// This seems to be the "id" of the official LiftMaster iOS app
var APP_ID = "JVM/G9Nwih5BwKgNCjLxiFUQxQijAebyyg8QUHr7JOrP+tuPb8iHfRHKwTmDzHOu"

function LiftMasterAccessory(log, config) {
  this.log = log;
  this.name = config["name"];
  this.username = config["username"];
  this.password = config["password"];
  this.deviceID = config["deviceID"];

  // Seconds
  this.updateInterval = config["interval"] || 600;

  this.service = new Service.GarageDoorOpener(this.name);

  this.service.getCharacteristic(Characteristic.CurrentDoorState).on('get', this.handleHomeKitUpdateRequest.bind(this));
  this.service.getCharacteristic(Characteristic.TargetDoorState).on('set', this.setTargetState.bind(this));
  this.updateDoorStates();
  this.schedulePeriodicUpdate();
}

LiftMasterAccessory.prototype.setTargetState = function(state, callback, context) {
  if (!context) {
    return;
  }

  var that = this;
  if (this.deviceId != null) {
    this._updateTargetState(state, function(err) {
      callback(err);
      that.scheduleCurrentStateUpdate();
    });
  } else {
    this._login(function(error) {
      if (!error) {
        that._getDevice(function(error) {
          if (!error) {
            that._updateTargetState(state, function(err) {
              callback(err);
              if (!err) {
                that.scheduleCurrentStateUpdate();
              }
            });
          } else {
            callback(error);
          }
        });
      } else {
        callback(error);
      }
    });
  }
}

LiftMasterAccessory.prototype.schedulePeriodicUpdate = function() {
  var that = this;

  setTimeout(function() {
    that.updateDoorStates(function(error) {
      that.schedulePeriodicUpdate();
    })
  }, this.updateInterval * 1000);
}

LiftMasterAccessory.prototype.scheduleCurrentStateUpdate = function() {
  var that = this;
  if (this.deviceState > 2) {
    setTimeout(function() {
      that.updateDoorStates(function(error) {
        if (!error) {
          if (that.deviceState > 2) {
            that.scheduleCurrentStateUpdate();
          }
        } else {
          that.scheduleCurrentStateUpdate();
        }
      })
    }, 10000); // 10s
  }
}

LiftMasterAccessory.prototype.handleHomeKitUpdateRequest = function(callback) {
  var that = this;

  this.updateState(function(error) {
    if (!error) {
      if (that.deviceState == 1) {
        callback(null, 0);
      } else if (that.deviceState == 2) {
        callback(null, 1);
      } else if (that.deviceState == 4) {
        callback(null, 2);
      } else if (that.deviceState == 5) {
        callback(null, 3);
      }
    } else {
      callback(error);
    }
  });
}

LiftMasterAccessory.prototype.updateDoorStates = function(callback) {
  var that = this;

  this.updateState(function(error) {
    if (!error) {
      if (that.deviceState == 1) {
        that.service.setCharacteristic(Characteristic.TargetDoorState, 0);
        that.service.setCharacteristic(Characteristic.CurrentDoorState, 0);
      } else if (that.deviceState == 2) {
        that.service.setCharacteristic(Characteristic.TargetDoorState, 1);
        that.service.setCharacteristic(Characteristic.CurrentDoorState, 1);
      } else if (that.deviceState == 4) {
        that.service.setCharacteristic(Characteristic.TargetDoorState, 0);
        that.service.setCharacteristic(Characteristic.CurrentDoorState, 2);
      } else if (that.deviceState == 5) {
        that.service.setCharacteristic(Characteristic.TargetDoorState, 1);
        that.service.setCharacteristic(Characteristic.CurrentDoorState, 3);
      }
    }

    if (callback) {
      callback(error);
    }
  });
}

LiftMasterAccessory.prototype.updateState = function(callback) {
  var that = this;

  if (this.deviceId != null) {
    this._getDevice(function(err) {
      callback(err);
    });
  } else {
    this._login(function(error) {
      if (!error) {
        that._getDevice(function(error) {
          callback(error);
        });
      } else {
        callback(error);
      }
    });
  }
}

LiftMasterAccessory.prototype._login = function(callback) {
  var that = this;

  // reset our logged-in state hint until we're logged in
  this.deviceId = null;

  // querystring params
  var query = {
    appId: APP_ID,
    username: this.username,
    password: this.password,
    culture: "en"
  };

  // login to liftmaster
  request.get({
    url: "https://myqexternal.myqdevice.com/api/user/validatewithculture",
    qs: query
  }, function(err, response, body) {
    if (!err && response.statusCode == 200) {

      // parse and interpret the response
      var json = JSON.parse(body);
      that.userId = json["UserId"];
      that.securityToken = json["SecurityToken"];
      that.log("Logged in with user ID " + that.userId);
      callback();
    }
    else {
      that.log("Error '"+err+"' logging in: " + body);
      callback(err);
    }
  }).on('error', function(err) {
    that.log(err);
    callback(err);
  });
}

LiftMasterAccessory.prototype._getDevice = function(callback) {
  var that = this;

  // querystring params
  var query = {
    appId: APP_ID,
    SecurityToken: this.securityToken,
    filterOn: "true"
  };

  // some necessary duplicated info in the headers
  var headers = {
    MyQApplicationId: APP_ID,
    SecurityToken: this.securityToken
  };

  // request details of all your devices
  request.get({
    url: "https://myqexternal.myqdevice.com/api/v4/userdevicedetails/get",
    qs: query,
    headers: headers
  }, function(err, response, body) {

    if (!err && response.statusCode == 200) {

      // parse and interpret the response
      var json = JSON.parse(body);
      var devices = json["Devices"];
      var foundDoors = [];

      // look through the array of devices for an opener
      for (var i=0; i<devices.length; i++) {
        var device = devices[i];

        if (device["MyQDeviceTypeName"] == "Garage Door Opener WGDO" || device["MyQDeviceTypeName"] == "GarageDoorOpener" || device["MyQDeviceTypeName"] == "VGDO") {

          // If we haven't explicity specified a door ID, we'll loop to make sure we don't have multiple openers, which is confusing
          if (!that.deviceID) {
            var thisDeviceId = device.MyQDeviceId;
            var thisDoorName = "Unknown";
            var thisDoorState = 2;

            for (var j = 0; j < device.Attributes.length; j ++) {
              var thisAttributeSet = device.Attributes[j];
              if (thisAttributeSet.AttributeDisplayName == "desc") {
                thisDoorName = thisAttributeSet.Value;
                break;
              }
              if (thisAttributeSet.AttributeDisplayName == "doorstate") {
                thisDoorState = thisAttributeSet.Value;
              }
            }
            foundDoors.push(thisDeviceId + " - " + thisDoorName);
            that.deviceId = thisDeviceId;
            // Map device state back to HomeKit states
            that.deviceState = thisDoorState;
          }

          // We specified a door ID, sanity check to make sure it's the one we expected
          else if (that.deviceID == device.MyQDeviceId) {
          // Added attribute loop here to pull doorstate
            var thisDeviceId = device.MyQDeviceId;

            for (var j = 0; j < device.Attributes.length; j ++) {
              var thisAttributeSet = device.Attributes[j];
              if (thisAttributeSet.AttributeDisplayName == "doorstate") {
                thisDoorState = thisAttributeSet.Value;
            }
          }
          that.deviceId = device.MyQDeviceId;
          that.deviceState = thisDoorState;
          break;
          }
        }
      }

      // If we have multiple found doors, refuse to proceed
      if (foundDoors.length > 1) {
        that.log("WARNING: You have multiple doors on your MyQ account.");
        that.log("WARNING: Specify the ID of the door you want to control using the 'deviceID' property in your config.json file.");
        that.log("WARNING: You can have multiple liftmaster accessories to cover your multiple doors");

        for (var j = 0; j < foundDoors.length; j++) {
          that.log("Found Door: " + foundDoors[j]);
        }

        throw "FATAL: Please specify which specific door this Liftmaster accessory should control - you have multiples on your account";

      }

      // Did we get a device ID?
      if (that.deviceId) {
        that.log("Found an opener with ID " + that.deviceId +".");
        callback();
      }
      else
      {
        that.log("Error: Couldn't find a door device, or the ID you specified isn't associated with your account");
        callback("Missing Device ID");
      }
    }
    else {
      that.log("Error '"+err+"' getting devices: " + body);
      callback(err);
    }
  }).on('error', function(err) {
    that.log(err);
    callback(err);
  });
}

LiftMasterAccessory.prototype._updateTargetState = function(state, callback) {
  var that = this;
  var liftmasterState = (state + "") == "1" ? "0" : "1";

  // querystring params
  var query = {
    appId: APP_ID,
    SecurityToken: this.securityToken,
    filterOn: "true"
  };

  // some necessary duplicated info in the headers
  var headers = {
    MyQApplicationId: APP_ID,
    SecurityToken: this.securityToken
  };

  // PUT request body
  var body = {
    AttributeName: "desireddoorstate",
    AttributeValue: liftmasterState,
    ApplicationId: APP_ID,
    SecurityToken: this.securityToken,
    MyQDeviceId: this.deviceId
  };

  // send the state request to liftmaster
  request.put({
    url: "https://myqexternal.myqdevice.com/api/v4/DeviceAttribute/PutDeviceAttribute",
    qs: query,
    headers: headers,
    body: body,
    json: true
  }, function(err, response, json) {
    if (!err && response.statusCode == 200) {

      if (json["ReturnCode"] == "0") {
        that.log("State was successfully set.");

        if (state === 0) {
          that.deviceState = 4;
          that.service.setCharacteristic(Characteristic.CurrentDoorState, 2);
        } else {
          that.deviceState = 5;
          that.service.setCharacteristic(Characteristic.CurrentDoorState, 3);
        }

        callback();
      } else {
        that.log("Bad return code: " + json["ReturnCode"]);
        that.log("Raw response " + JSON.stringify(json));
        callback("Unknown Error");
      }
    }
    else {
      that.log("Error '"+err+"' setting door state: " + JSON.stringify(json));
      callback(err);
    }
  }).on('error', function(err) {
    that.log(err);
    callback(err);
  });
}

LiftMasterAccessory.prototype.getServices = function() {
  return [this.service];
}
