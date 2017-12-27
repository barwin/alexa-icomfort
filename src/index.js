global.auth = {username: "", password: ""}; // YOUR USERNAME AND PASSWORD FOR MYICOMFORT.COM GO HERE

var iComfort = new (require("icomfort"))(global.auth);

/**
 * Main entry point.
 * Incoming events from Alexa Lighting APIs are processed via this method.
 */
exports.handler = function(event, context) {
    const directive = event.directive;

    switch (directive.header.name) {
        case "Discover":
            handleDiscovery(directive, context);
            break;
        case "SetTargetTemperature":
            handleChangeRequest(directive, context);
            break;
        case "ReportState":
            handleStateRequest(directive, context);
            break;
        default:
            console.log("Error, unsupported request: " + directive.header.name);
            context.fail("Something went wrong");
    }
};

/**
 * This method is invoked when we receive a "Discovery" message from Alexa Connected Home Skill.
 * We are expected to respond back with a list of appliances that we have discovered for a given
 * customer.
 */
function handleDiscovery(accessToken, context) {
    // Crafting the response header
    var headers = {
        namespace: "Alexa.Discovery",
        name: "Discover.Response",
        payloadVersion: "3"
    };

    // Response body will be an array of discovered devices
    var appliances = [];
    var getSystemsInfoParams = {UserId:global.auth.username};


    iComfort.getSystemsInfo(getSystemsInfoParams)
        .then( function(systemInfo) {
            var systemAppliances = systemInfo.Systems;
            for (var i = 0; i < systemAppliances.length; i++) {
                var thermostat = {
                    endpointId: systemAppliances[i].Gateway_SN,
                    friendlyName: systemAppliances[i].System_Name, // Name can be changed in iComfort
                    description: "Lennox iComfort Thermostat",
                    manufacturerName: "Lennox",
                    displayCategories: ["THERMOSTAT"],
                    cookie: {},
                    capabilities: [
                        {
                          type: "AlexaInterface",
                          interface: "Alexa",
                          version: "3"
                        },
                        {
                          type: "AlexaInterface",
                          interface: "Alexa.ThermostatController",
                          version: "3",
                          properties: {
                            supported: [
                              { name: "lowerSetpoint" },
                              { name: "targetSetpoint" },
                              { name: "upperSetpoint" },
                              { name: "thermostatMode" }
                            ],
                            proactivelyReported: false,
                            retrievable: true
                          }
                        },
                        {
                          type: "AlexaInterface",
                          interface: "Alexa.TemperatureSensor",
                          version: "3",
                          properties: {
                            supported: [ { name: "temperature" } ],
                            proactivelyReported: false,
                            retrievable: true
                          }
                        }
                    ]
                };
                appliances.push(thermostat);
            }
            var payloads = {
                discoveredAppliances: appliances
            };
            var result = {
                event: {
                    header: headers,
                    payload: payloads
                }
            };

            context.succeed(result);
        })
        .catch(console.error);
}

function handleChangeRequest(directive, context) {
    // Retrieve the appliance id from the incoming Alexa request.
    var applianceId = directive.endpoint.endpointId;
    var messageId = directive.header.messageId;
    var token = directive.header.correlationToken;

    var getThermostatInfoListParams = {
        GatewaySN: applianceId,
        TempUnit: 0
    };

    // Query Lennox for current parameters and potential temp spread, perform changes on promise fulfillments
    Promise.all([
        iComfort.getThermostatInfoList(getThermostatInfoListParams),
        iComfort.getGatewayInfo(getThermostatInfoListParams)
    ])
    .then( function(responses) {
        // Response data to overwrite with new values and put to Lennox
        // Lennox temperature always returned in Fahrenheit, convert to Celsius if preferred in Lennox

        var response = responses[0].tStatInfo[0];
        var range = responses[1].Heat_Cool_Dead_Band;
        var units = "FAHRENHEIT";

        if (response.Pref_Temp_Units === "1") {
            units = "CELSIUS";
        }

        var currentParams = {
            systemStatus: response.System_Status,
            timeStamp: new Date(parseInt(response.DateTime_Mark.replace("/Date(","").replace(")/",""), 10)),
            allowedRange: range,
            currentTemp: {
                value: response.Indoor_Temp,
                heatToValue: response.Heat_Set_Point,
                coolToValue: response.Cool_Set_Point,
                scale: units
            },
            requestedTemp: convertRequestUnits(directive.payload),
            toSet: response
        };
        var newParams = {};

        newParams = determineNewParameters(currentParams);

        // send the change request to Lennox, send a response to Alexa on promise fulfillment
        iComfort.setThermostatInfo(newParams.toSet)
        .then( function(newSettings) {
            alexaChangeConfirmation(applianceId, messageId, token, newParams, currentParams.timeStamp);
        })
        .catch(console.error);

    })
    .catch(console.error);

    var alexaChangeConfirmation = function(applianceId, messageId, token, newParams, timeStamp) {
        if (newParams.originalScale != "FAHRENHEIT") {
            newParams.toSet.Indoor_Temp = fToC(newParams.toSet.Indoor_Temp);
        }
        var result = {
            context: {
                properties: [ {
                    namespace: "Alexa.ThermostatController",
                    name: "targetSetpoint",
                    value: {
                        value: newParams.toSet.Indoor_Temp,
                        scale: newParams.originalScale
                    },
                    timeOfSample: timeStamp,
                    uncertaintyInMilliseconds: 1000
                },
                {
                    namespace: "Alexa.ThermostatController",
                    name: "lowerSetpoint",
                    value: {
                        value: newParams.toSet.Heat_Set_Point,
                        scale: newParams.originalScale
                    },
                    timeOfSample: timeStamp,
                    uncertaintyInMilliseconds: 1000
                },
                {
                    namespace: "Alexa.ThermostatController",
                    name: "upperSetpoint",
                    value: {
                        value: newParams.toSet.Cool_Set_Point,
                        scale: newParams.originalScale
                    },
                    timeOfSample: timeStamp,
                    uncertaintyInMilliseconds: 1000
                },
                {
                    namespace: "Alexa.ThermostatController",
                    name: "thermostatMode",
                    value: newParams.temperatureMode,
                    timeOfSample: timeStamp,
                    uncertaintyInMilliseconds: 1000
                } ]
            },
            event: {
                header: {
                    namespace: "Alexa",
                    name: "Response",
                    payloadVersion: "3",
                    messageId: messageId,
                    correlationToken: token
                }
            },
            endpoint: {
                endpointId: applianceId
            },
            payload: {}
        };
        context.succeed(result);
    };

}

function handleStateRequest(directive, context) {
    // Retrieve the appliance id and accessToken from the incoming Alexa request.
    var applianceId = directive.endpoint.endpointId;
    var messageId = directive.header.messageId;
    var token = directive.header.correlationToken;

    var getThermostatInfoListParams = {
        GatewaySN: applianceId,
        TempUnit: 0
    };

    // Query Lennox for current parameters and potential temp spread, perform changes on promise fulfillments
    Promise.all([
        iComfort.getThermostatInfoList(getThermostatInfoListParams),
        iComfort.getGatewayInfo(getThermostatInfoListParams)
    ])
    .then( function(responses) {
        // Response data to overwrite with new values and put to Lennox
        // Lennox temperature returned in Farenheit, convert to Celsius for Alexa
        var response = responses[0].tStatInfo[0];
        var units = "FAHRENHEIT"; // default unit of all returned temp data regardless of preferences
        var temp = response.Indoor_Temp;

        if (response.Pref_Temp_Units === "1") {
            units = "CELSIUS";
            temp = fToC(response.Indoor_Temp);
        }

        var currentParams = {
            timestamp: new Date(parseInt(response.DateTime_Mark.replace("/Date(","").replace(")/",""), 10)),
            currentTemp: temp,
            deviceUnits: units
        };

        alexaCurrentTempInfo(applianceId, currentParams.currentTemp, currentParams.deviceUnits, currentParams.timestamp);
    })
    .catch(console.error);

    var alexaCurrentTempInfo = function(applianceId, currentTemp, deviceUnits, timeStamp) {
        var result = {
            context: {
                properties: [{
                    namespace: "Alexa.TemperatureSensor",
                    name: "temperature",
                    value: {
                        value: currentTemp,
                        scale: deviceUnits
                    },
                    timeOfSample: timeStamp,
                    uncertaintyInMilliseconds: 1000
                }]
            },
            event: {
                header: {
                    namespace: "Alexa",
                    name: "StateReport",
                    payloadVersion: "3",
                    messageId: messageId,
                    correlationToken: token
                },
                endpoint: {
                    endpointId: applianceId
                },
                payload: {}
            }
        };

        context.succeed(result);
    };
}

function determineNewParameters(currentParams) {
    // System_Status magic numbers: 0 == idle, 1 == heating, 2 == cooling, 3 == waiting

    var newParams = {
        toSet: currentParams.toSet,
        originalScale: currentParams.requestedTemp.originalScale
    };
    var request = currentParams.requestedTemp.payload;
    var colderOutside = (currentParams.currentTemp.value - currentParams.currentTemp.heatToValue) < (currentParams.currentTemp.coolToValue - currentParams.currentTemp.value) || currentParams.systemStatus === 1;

    // Lennox ignores setting the temp directly and requires setting the upper and lower ranges, use those units if provided
    if ("lowerSetpoint" in request && "upperSetpoint" in request) {
        newParams.toSet.Indoor_Temp = request.targetSetpoint.value || (colderOutside ? request.lowerSetpoint.value : request.upperSetpoint.value);
        // setting the upper and lower too close together will fail, check to make sure it's equal to or greater than the allowed range
        if (currentParams.allowedRange <= (request.upperSetpoint.value - request.lowerSetpoint.value)) {
            newParams.toSet.Heat_Set_Point = request.lowerSetpoint.value;
            newParams.toSet.Cool_Set_Point = request.upperSetpoint.value;
            newParams.temperatureMode = colderOutside ? "HEAT" : "COOL";
        } else {
            if (currentParams.currentTemp.value <= request.lowerSetpoint.value || colderOutside) {
                newParams.toSet.Heat_Set_Point = request.lowerSetpoint.value;
                newParams.toSet.Cool_Set_Point = request.lowerSetpoint.value + currentParams.allowedRange;
                newParams.temperatureMode = "HEAT";
            } else {
                newParams.toSet.Heat_Set_Point = request.upperSetpoint.value - currentParams.allowedRange;
                newParams.toSet.Cool_Set_Point = request.upperSetpoint.value;
                newParams.temperatureMode = "COOL";
            }
        }
    } else if ("targetSetpoint" in request) {
        newParams.toSet.Indoor_Temp = request.targetSetpoint.value;

        if (colderOutside) {
            newParams.toSet.Heat_Set_Point = request.targetSetpoint.value;
            newParams.toSet.Cool_Set_Point = request.targetSetpoint.value + currentParams.allowedRange;
            newParams.temperatureMode = "HEAT";
        } else {
            newParams.toSet.Heat_Set_Point = request.targetSetpoint.value - currentParams.allowedRange;
            newParams.toSet.Cool_Set_Point = request.targetSetpoint.value;
            newParams.temperatureMode = "COOL";
        }
    }

    return newParams;

}

// function to check and convert incoming requests to Fahrenheit (Lennox only deals with Fahrenheit for temp changes, even if it displays Celcius)
function convertRequestUnits(payload) {
    var payloadForLennox = {
        payload: payload,
        originalScale: "FAHRENHEIT"
    }

    for (var key in payload) {
        if (payload[key].scale !== "FAHRENHEIT") {
            payloadForLennox.payload[key].value = cToF(payload[key].value);
            payloadForLennox.originalScale = payload[key].scale;
        }
    }
    return payloadForLennox;
}

// function to convert Celcius (Alexa default) to Fahrenheit
function cToF(celsius) {
    return Math.round((celsius * 9 / 5 + 32) * 2 ) / 2;
}

// function to convert Fahrenheit to Celcius (Alexa default)
function fToC(fahrenheit) {
  return Math.round(((fahrenheit - 32) * 5 / 9) * 2) / 2;
}
