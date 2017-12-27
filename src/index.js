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
        case "change":
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
    var getSystemsInfoParams = {UserId:auth.username};


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
                              {
                                name: "lowerSetpoint"
                              },
                              {
                                name: "targetSetpoint"
                              },
                              {
                                name: "upperSetpoint"
                              },
                              {
                                name: "thermostatMode"
                              }
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
                            supported: [
                              {
                                name: "temperature"
                              }
                            ],
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


/**
 * Control events are processed here.
 * This is called when Alexa requests an action (e.g., "turn off appliance").
 */
function handleChangeRequest(directive, context) {
    // Retrieve the appliance id from the incoming Alexa request.
    var applianceId = directive.endpoint.endpointId;
    var message_id = directive.header.messageId;
    var confirmation;

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
        var currentParams = {
                systemStatus: responses[0].tStatInfo[0].System_Status,
                allowedRange: responses[1].Heat_Cool_Dead_Band,
                currentTemp: responses[0].tStatInfo[0].Indoor_Temp,
                currentHeatTo: responses[0].tStatInfo[0].Heat_Set_Point,
                currentCoolTo: responses[0].tStatInfo[0].Cool_Set_Point,
                toSet: responses[0].tStatInfo[0]
            },
            newParams = {};

        // check to see what type of request was made before changing temperature
        switch (event.header.name) {
            case "SetTargetTemperatureRequest":
                currentParams.requestedTemp = event.payload.targetTemperature.value;
                newParams = determineNewParameters(currentParams);
                confirmation = "SetTargetTemperatureConfirmation";
                break;
            case "IncrementTargetTemperatureRequest":
                var increment = event.payload.deltaTemperature.value;

                currentParams.requestedTemp = fToC(currentParams.toSet.Indoor_Temp) + increment;
                newParams = determineNewParameters(currentParams);
                confirmation = "IncrementTargetTemperatureConfirmation";
                break;
            case "DecrementTargetTemperatureRequest":
                var decrement = event.payload.deltaTemperature.value;

                currentParams.requestedTemp = fToC(currentParams.toSet.Indoor_Temp) - decrement;
                newParams = determineNewParameters(currentParams);
                confirmation = "DecrementTargetTemperatureConfirmation";
                break;
        }

        // send the change request to Lennox, send a response to Alexa on promise fulfillment
        iComfort.setThermostatInfo(newParams.toSet)
        .then( function(newSettings) {
            alexaChangeConfirmation(newParams.alexaTargetTemp, confirmation, newParams.temperatureMode, currentParams.currentTemp);
        })
        .catch(console.error);

    })
    .catch(console.error);

    var alexaChangeConfirmation = function(targetTemp, confirmation, tempMode, originalTemp) {
        var result = {
            header: {
                namespace: "Alexa.ConnectedHome.Control",
                name: confirmation,
                payloadVersion: "2",
                messageId: message_id // reuses initial message ID, probably not desirable?
            },
            payload: {
                targetTemperature: {
                    value: targetTemp
                }
            },
            temperatureMode: {
                value: tempMode
            },
            previousState: {
                targetTemperature: {
                    value: originalTemp
                },
                mode: {
                    value: tempMode
                }
            }
        };
        context.succeed(result);
    };
}

/**
 * Control events are processed here.
 * This is called when Alexa requests an action (e.g., "turn off appliance").
 */
function handleStateRequest(directive, context) {
    // Retrieve the appliance id and accessToken from the incoming Alexa request.
    var applianceId = directive.endpoint.endpointId;
    var message_id = directive.header.messageId;

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
                    messageId: message_id // reuses initial message ID, probably not desirable?
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
    var newParams = {
            temperatureMode: "AUTO",
            alexaTargetTemp: currentParams.requestedTemp, // in Celsius
            toSet: currentParams.toSet
        },
        dropTemp = (currentParams.currentTemp - currentParams.requestedTemp) > 0; // if this evaluates to false, we stay at the same temp OR increase temp

    newParams.toSet.Indoor_Temp = Math.round(cToF(currentParams.requestedTemp));

    // System_Status magic numbers: 0 == idle, 1 == heating, 2 == cooling, 3 == waiting

    // temp is at bottom of current range, i.e. it's colder outside than inside, OR system is heating
    if ((currentParams.currentTemp - currentParams.currentHeatTo) < (currentParams.currentCoolTo - currentParams.currentTemp) || currentParams.systemStatus === 1) {
        // raise or lower the bottom accordingly
        newParams.toSet.Heat_Set_Point = Math.round(cToF(currentParams.requestedTemp));
        // check to see if existing top is at least the allowed range above the new bottom, if not, raise it at least that much
        if (!dropTemp && (newParams.toSet.Heat_Set_Point + currentParams.allowedRange) > newParams.toSet.Cool_Set_Point) {
            newParams.toSet.Cool_Set_Point = newParams.toSet.Heat_Set_Point + currentParams.allowedRange;
        }
    }
    // temp is at top of current range, i.e. it's hotter outside than inside, OR system is cooling
    else if ((currentParams.currentTemp - currentParams.currentHeatTo) > (currentParams.currentCoolTo - currentParams.currentTemp) || currentParams.systemStatus === 2) {
        // raise or lower the top accordingly
        newParams.toSet.Cool_Set_Point = Math.round(cToF(currentParams.requestedTemp));
        // check to see if existing bottom is at least the allowed range above the new top, if not, raise it at least that much
        if (dropTemp && (newParams.toSet.Cool_Set_Point - currentParams.allowedRange) < newParams.toSet.Heat_Set_Point) {
            newParams.toSet.Heat_Set_Point = newParams.toSet.Cool_Set_Point - currentParams.allowedRange;
        }
    }

    if (currentParams.requestedTemp > currentParams.currentTemp) {
        newParams.temperatureMode = "HEAT";
    } else if (currentParams.requestedTemp < currentParams.currentTemp) {
        newParams.temperatureMode = "COOL";
    }

    return newParams;
}

// function to convert Celcius (Alexa default) to Fahrenheit
function cToF(celsius) {
    return Math.round((celsius * 9 / 5 + 32) * 2 ) / 2;
}

// function to convert Fahrenheit to Celcius (Alexa default)
function fToC(fahrenheit) {
  return Math.round(((fahrenheit - 32) * 5 / 9) * 2) / 2;
}
