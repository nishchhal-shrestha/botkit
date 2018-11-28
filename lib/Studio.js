var request = require('request');
var Promise = require('promise');
var md5 = require('md5');
var SDK = require('botkit-studio-sdk');

module.exports = function(controller) {
    var before_hooks = {};
    var after_hooks = {};
    var answer_hooks = {};
    var thread_hooks = {};

    // define a place for the studio specific features to live.
    controller.studio = {};

    /* ----------------------------------------------------------------
     * Botkit Studio Script Services
     * The features in this section grant access to Botkit Studio's
     * script and trigger services
     * ---------------------------------------------------------------- */


    function genConfig(bot) {
        var config = {};

        if (bot.config && bot.config.studio_token) {
            config.studio_token = bot.config.studio_token;
        }

        if (bot.config && bot.config.studio_command_uri) {
            config.studio_command_uri = bot.config.studio_command_uri;
        }

        if (controller.config && controller.config.studio_token) {
            config.studio_token = controller.config.studio_token;
        }

        if (controller.config && controller.config.studio_command_uri) {
            config.studio_command_uri = controller.config.studio_command_uri;
        }

        return config;
    }

    controller.studio.evaluateTrigger = function(bot, text, user) {

        // var userHash = md5(user);
        var sdk = new SDK(genConfig(bot));
        return sdk.evaluateTrigger(text, user);

    };

    // get Botkit Studio identity
    controller.studio.identify = function(bot) {
        var sdk = new SDK(genConfig(bot || {}));
        return sdk.identify();
    };

    // get command list
    controller.studio.getScripts = function(bot, tag) {
        var sdk = new SDK(genConfig(bot || {}));
        return sdk.getScripts(tag);
    };

    // create a simple script
    // with a single trigger and single reply
    controller.studio.createScript = function(bot, trigger, text) {
        var sdk = new SDK(genConfig(bot || {}));
        return sdk.createScript(trigger, text);
    };

    // load a script from the pro service
    controller.studio.getScriptById = function(bot, id, user) {

        var userHash = md5(user);
        var sdk = new SDK(genConfig(bot));
        return sdk.getScriptById(id, user);
    };

    // load a script from the pro service
    controller.studio.getScript = function(bot, text, user) {

        // var userHash = md5(user);
        var sdk = new SDK(genConfig(bot));
        return sdk.getScript(text, user);
    };


    // these are middleware functions
    controller.studio.validate = function(command_name, key, func) {

        if (!answer_hooks[command_name]) {
            answer_hooks[command_name] = [];

        }
        if (key && !answer_hooks[command_name][key]) {
            answer_hooks[command_name][key] = [];
        }

        answer_hooks[command_name][key].push(func);

        return controller.studio;
    };


    controller.studio.beforeThread = function(command_name, thread_name, func) {

        if (!thread_hooks[command_name]) {
            thread_hooks[command_name] = [];

        }
        if (thread_name && !thread_hooks[command_name][thread_name]) {
            thread_hooks[command_name][thread_name] = [];
        }

        thread_hooks[command_name][thread_name].push(func);

        return controller.studio;
    };



    controller.studio.before = function(command_name, func) {

        if (!before_hooks[command_name]) {
            before_hooks[command_name] = [];
        }

        before_hooks[command_name].push(func);

        return controller.studio;
    };

    controller.studio.after = function(command_name, func) {

        if (!after_hooks[command_name]) {
            after_hooks[command_name] = [];
        }

        after_hooks[command_name].push(func);

        return controller.studio;

    };

    function runHooks(hooks, convo, cb) {

        if (!hooks || !hooks.length) {
            return cb(convo);
        }

        var func = hooks.shift();

        func(convo, function() {
            if (hooks.length) {
                runHooks(hooks, convo, cb);
            } else {
                return cb(convo);
            }
        });
    }


    /* Fetch a script from Botkit Studio by name, then execute it.
     * returns a promise that resolves when the conversation is loaded and active */
    controller.studio.run = function(bot, input_text, user, channel, original_message) {

        return new Promise(function(resolve, reject) {

            controller.studio.get(bot, input_text, user, channel, original_message).then(function(convo) {
                convo.activate();
                resolve(convo);
            }).catch(function(err) {
                reject(err);
            });
        });

    };

    /* Fetch a script from Botkit Studio by name, but do not execute it.
     * returns a promise that resolves when the conversation is loaded
     * but developer still needs to call convo.activate() to put it in motion */
    controller.studio.get = function(bot, input_text, user, channel, original_message) {
        var context = {
            text: input_text,
            user: user,
            channel: channel,
            raw_message: original_message ? original_message.raw_message : null,
            original_message: original_message || null
        };
        return new Promise(function(resolve, reject) {
            controller.studio.getScript(bot, input_text, user).then(function(command) {
                if (command !== {} && command.id) {
                    controller.trigger('command_triggered', [bot, context, command]);

                    // make the script source information from Botkit Studio available to Botkit's convo object
                    context.script_name = command.command;
                    context.script_id = command._id;

                    controller.studio.compileScript(
                        bot,
                        context,
                        command
                    ).then(function(convo) {
                        convo.on('end', function(convo) {
                            runHooks(
                                after_hooks[command.command] ? after_hooks[command.command].slice() : [],
                                convo,
                                function(convo) {
                                    controller.trigger('remote_command_end', [bot, context, command, convo]);
                                }
                            );
                        });
                        runHooks(
                            before_hooks[command.command] ? before_hooks[command.command].slice() : [],
                            convo,
                            function(convo) {
                                resolve(convo);
                            }
                        );
                    }).catch(function(err) {
                        reject(err);
                    });
                } else {
                    reject('Script not found');
                }
            }).catch(function(err) {
                reject(err);
            });
        });
    };

    /* Fetch a script from Botkit Studio by id, but do not execute it.
     * returns a promise that resolves when the conversation is loaded
     * but developer still needs to call convo.activate() to put it in motion */
    controller.studio.getById = function(bot, id, user, channel, original_message) {
        var context = {
            id: id,
            user: user,
            channel: channel,
            raw_message: original_message ? original_message.raw_message : null,
            original_message: original_message || null
        };
        return new Promise(function(resolve, reject) {
            controller.studio.getScriptById(bot, id, user).then(function(command) {
                if (command !== {} && command.id) {
                    controller.trigger('command_triggered', [bot, context, command]);

                    // make the script source information from Botkit Studio available to Botkit's convo object
                    context.script_name = command.command;
                    context.script_id = command._id;

                    controller.studio.compileScript(
                        bot,
                        context,
                        command
                    ).then(function(convo) {
                        convo.on('end', function(convo) {
                            runHooks(
                                after_hooks[command.command] ? after_hooks[command.command].slice() : [],
                                convo,
                                function(convo) {
                                    controller.trigger('remote_command_end', [bot, context, command, convo]);
                                }
                            );
                        });
                        runHooks(
                            before_hooks[command.command] ? before_hooks[command.command].slice() : [],
                            convo,
                            function(convo) {
                                resolve(convo);
                            }
                        );
                    }).catch(function(err) {
                        reject(err);
                    });
                } else {
                    reject('Script not found');
                }
            }).catch(function(err) {
                reject(err);
            });

        });
    };

    controller.studio.runTrigger = function(bot, input_text, user, channel, original_message) {
        var context = {
            text: input_text,
            user: user,
            channel: channel,
            raw_message: original_message ? original_message.raw_message : null,
            original_message: original_message || null
        };

        context.isSubscription = original_message.isSubscription;
        context.messaging_type = original_message.new_messaging_type || 'NON_PROMOTIONAL_SUBSCRIPTION';

        return new Promise(function(resolve, reject) {
            controller.studio.evaluateTrigger(bot, input_text, user).then(function(command) {
                if (command !== {} && command.id) {
                    controller.trigger('command_triggered', [bot, context, command]);

                    // make the script source information from Botkit Studio available to Botkit's convo object
                    context.script_name = command.command;
                    context.script_id = command._id;

                    controller.studio.compileScript(
                        bot,
                        context,
                        command
                    ).then(function(convo) {

                        convo.on('end', function(convo) {
                            runHooks(
                                after_hooks[command.command] ? after_hooks[command.command].slice() : [],
                                convo,
                                function(convo) {
                                    controller.trigger('remote_command_end', [bot, context, command, convo]);
                                }
                            );
                        });

                        runHooks(
                            before_hooks[command.command] ? before_hooks[command.command].slice() : [],
                            convo,
                            function(convo) {
                                convo.activate();
                                resolve(convo);
                            }
                        );
                    }).catch(function(err) {
                        reject(err);
                    });
                } else {
                    // return with no conversation
                    // allow developer to run a default script
                    resolve(null);
                }
            }).catch(function(err) {
                reject(err);
            });
        });

    };


    controller.studio.testTrigger = function(bot, input_text, user, channel) {
        var context = {
            text: input_text,
            user: user,
            channel: channel,
        };
        return new Promise(function(resolve, reject) {
            controller.studio.evaluateTrigger(bot, input_text, user).then(function(command) {
                if (command !== {} && command.id) {
                    resolve(true);
                } else {
                    resolve(false);
                }
            }).catch(function(err) {
                reject(err);
            });
        });

    };


    controller.studio.compileScript = function(bot, message, command) {
        function makeHandler(options, field) {
            var pattern = '';

            if (options.type == 'utterance') {
                pattern = controller.utterances[options.pattern];
            } else if (options.type == 'string') {
                var p = options.pattern;
                p = p.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
                pattern = '^' + p + '$';
            } else if (options.type == 'regex') {
                pattern = options.pattern;
            }

            return {
                pattern: pattern,
                default: options.default,
                callback: function(response, convo) {
                    var hooks = [];
                    if (field.key && answer_hooks[command.command] && answer_hooks[command.command][field.key]) {
                        hooks = answer_hooks[command.command][field.key].slice();
                    }
                    if (options.action != 'wait' && field.multiple) {
                        convo.responses[field.key].pop();
                    }

                    runHooks(hooks, convo, function(convo) {
                        convo.handleAction(options);
                    });
                }
            };

        }

        return new Promise(function(resolve, reject) {
            let messageCopy = { ...message };
            
            bot.createConversation(message, async function(err, convo) {

                if (err) {
                    return reject(err);
                }

                // 15 minute default timeout
                convo.setTimeout(controller.config.default_timeout || (15 * 60 * 1000));
                
                // Try to store user if message is the initial starter conversation
                if (command.isStarterTrigger) {
                    if (bot && bot.getMessageUser) {
                        bot.getMessageUser(messageCopy).then((result) => {
                            const userData = {
                                user_id: messageCopy.user,
                                fb_id: result.id,
                                fb_username: result.username,
                                fb_fullname: result.full_name,
                                fb_firstname: result.first_name,
                                fb_lastname: result.last_name,
                                fb_gender: result.gender
                            };

                            try {
                                controller.storage.users.save(userData);
                            } catch (error) {
                                console.log('error while storing user: ', error);
                            }
                        })
                        .catch((error) => {
                            console.error('error while fetching user info from facebook', error);

                            const userData = {
                                user_id: messageCopy.user,
                            };

                            try {
                                controller.storage.users.save(userData);
                            } catch (error) {
                                console.log('error while storing user: ', error);
                            }
                        });
                    } else {
                        const userData = {
                            user_id: messageCopy.user,
                        };

                        try {
                            controller.storage.users.save(userData);
                        } catch (error) {
                            console.log('error while storing user: ', error);
                        }
                    }
                }

                // Populate convo vars with common user info if previously saved
        let userData;
        const commonAttributes = [
                    'user_age',
                    'user_email',
                    'user_phone',
                    'fb_gender',
                    'fb_username',
                    'fb_lastname',
                    'fb_fullname',
                    'fb_firstname',
         ];

        try {
          userData = await controller.storage.users.getByUserId(messageCopy.user);

          if (userData) {
            for (let attribute of commonAttributes) {
              const attributeMatch = userData.get(attribute);

              if (Array.isArray(attributeMatch) && attributeMatch.length) {
                attributeMatch.sort((a, b) => b.ts - a.ts);

                const latestAttribute = attributeMatch[0];

                if (latestAttribute && latestAttribute.value) {
                  convo.setVar(attribute, latestAttribute.value);
                }
              } else if (attributeMatch) {
                convo.setVar(attribute, attributeMatch);
              }
            }
          }
        } catch (error) {
          console.error('error while fetching user data', error);
        }

        // process any variables values and entities that came pre-defined as part of the script
        if (command.variables && command.variables.length) {
          for (var v = 0; v < command.variables.length; v++) {
                        if (userData) {
                            const attributeArray = userData.get(command.variables[v].name);

                            if (Array.isArray(attributeArray) && attributeArray.length) {
                                attributeArray.sort((a, b) => b.ts - a.ts);
                                const attributeMatch = attributeArray[0];

                                if (attributeMatch && attributeMatch.value) {
                                    convo.setVar(command.variables[v].name, attributeMatch.value);
                                }
                            }
                        }

                        if (command.variables[v].value) {

                            // set the key/value as a mustache variable
                            // accessible as {{vars.name}} in the templates
                            convo.setVar(command.variables[v].name, command.variables[v].value);

                            // also add this as an "answer" to a question
                            // thus making it available at {{responses.name}} and
                            // convo.extractResponse(name);
                            convo.responses[command.variables[v].name] = {
                                question: command.variables[v].name,
                                text: command.variables[v].value,
                            };
                        }
                    }
                }

                for (var t = 0; t < command.script.length; t++) {
                    var topic = command.script[t].topic;
                    for (var m = 0; m < command.script[t].script.length; m++) {

                        if (command.script[t].script[m].conditional) {

                            convo.addConditional({
                                conditional: command.script[t].script[m].conditional
                            }, topic);
                        } else {
                            var message = {};

                            if (messageCopy.isSubscription) {
                                message.messaging_type = messageCopy.messaging_type || 'NON_PROMOTIONAL_SUBSCRIPTION';
                            }

                            if (command.script[t].script[m].text) {
                                message.text = command.script[t].script[m].text;
                            }

                            // handle platform specific fields
                            if (bot.type == 'ciscospark') {
                                if (command.script[t].script[m].platforms && command.script[t].script[m].platforms.ciscospark) {
                                    // attach files.
                                    if (command.script[t].script[m].platforms.ciscospark.files) {
                                        message.files = [];
                                        for (var f = 0; f < command.script[t].script[m].platforms.ciscospark.files.length; f++) {
                                            message.files.push(command.script[t].script[m].platforms.ciscospark.files[f].url);
                                        }
                                    }
                                }
                            }

                            if (bot.type == 'web' || bot.type == 'socket') {
                                if (command.script[t].script[m].platforms && command.script[t].script[m].platforms.web) {
                                    // attach files.
                                    if (command.script[t].script[m].platforms.web.files) {
                                        message.files = [];
                                        for (var f = 0; f < command.script[t].script[m].platforms.web.files.length; f++) {

                                            // determine if this is an image or any other type of file.
                                            command.script[t].script[m].platforms.web.files[f].image =
                                              (command.script[t].script[m].platforms.web.files[f].url.match(/\.(jpeg|jpg|gif|png)$/i) != null);

                                            message.files.push(command.script[t].script[m].platforms.web.files[f]);
                                        }
                                    }
                                }
                            }


                            if (bot.type == 'teams') {
                                if (command.script[t].script[m].platforms && command.script[t].script[m].platforms.teams) {
                                    // create attachments in the Botkit message

                                    if (command.script[t].script[m].platforms && command.script[t].script[m].platforms.teams.attachmentLayout) {
                                        message.attachmentLayout = command.script[t].script[m].platforms && command.script[t].script[m].platforms.teams.attachmentLayout;
                                    }

                                    if (command.script[t].script[m].platforms.teams.attachments) {
                                        message.attachments = [];
                                        for (var a = 0; a < command.script[t].script[m].platforms.teams.attachments.length; a++) {
                                            var data = command.script[t].script[m].platforms.teams.attachments[a];
                                            var attachment = {};
                                            if (data.type == 'o365') {
                                                attachment.contentType = 'application/vnd.microsoft.card.O365Connector'; // + data.type,
                                                data['@type'] = 'MessageCard';
                                                data['@context'] = 'http://schema.org/extensions';
                                                delete(data.type);
                                                attachment.content = data;
                                            } else if (data.type != 'file') {
                                                attachment = bot.createAttachment(data.type, data);
                                            } else {
                                                attachment.contentType = data.contentType;
                                                attachment.contentUrl = data.contentUrl;
                                                attachment.name = data.name;

                                            }
                                            message.attachments.push(attachment);
                                        }
                                    }
                                }
                            }





                            // handle Slack attachments
                            if (command.script[t].script[m].attachments) {
                                message.attachments = command.script[t].script[m].attachments;


                                // enable mrkdwn formatting in all fields of the attachment
                                for (var a = 0; a < message.attachments.length; a++) {
                                    message.attachments[a].mrkdwn_in = ['text', 'pretext', 'fields'];
                                    message.attachments[a].mrkdwn = true;
                                }
                            }

                            // handle Facebook attachments
                            if (command.script[t].script[m].fb_attachment) {
                                if (bot.type == 'web' || bot.type == 'socket') {
                                    var attachment = command.script[t].script[m].fb_attachment;
                                    if (attachment.template_type) {
                                        if (attachment.template_type == 'button') {
                                            attachment.text = message.text;
                                            let buttonsText = "";
                                            for(let buttonIndex in attachment.buttons) {
                                                if(attachment.buttons[buttonIndex].type == 'web_url') {
                                                    buttonsText += "\n\n[" + attachment.buttons[buttonIndex].title + "](" + attachment.buttons[buttonIndex].url + ")"
                                                }
                                            }

                                            message.text += buttonsText;

                                            if (!message.quick_replies) {
                                                message.quick_replies = [];
                                            }

                                            for(let buttonIndex in attachment.buttons) {
                                                if(attachment.buttons[buttonIndex].type == 'postback') {
                                                    message.quick_replies.push({
                                                        "content_type": "text",
                                                        "payload": attachment.buttons[buttonIndex].payload,
                                                        "title": attachment.buttons[buttonIndex].title                                                      
                                                    })
                                                }
                                            }
                                        }
                                        // message.attachment = {
                                        //     type: 'template',
                                        //     payload: attachment
                                        // };
                                    } else if (attachment.type) {
                                        message.attachment = attachment;
                                    }

                                    // blank text, not allowed with attachment
                                    //message.text = null;

                                    // remove blank button array if specified
                                    // if (message.attachment.payload.elements) {
                                    //     for (var e = 0; e < message.attachment.payload.elements.length; e++) {
                                    //         if (!message.attachment.payload.elements[e].buttons || !message.attachment.payload.elements[e].buttons.length) {
                                    //             delete(message.attachment.payload.elements[e].buttons);
                                    //         }
                                    //     }
                                    // }
                                } else {
                                    var attachment = command.script[t].script[m].fb_attachment;
                                    if (attachment.template_type) {
                                        if (attachment.template_type == 'button') {
                                            attachment.text = message.text;
                                        }
                                        message.attachment = {
                                            type: 'template',
                                            payload: attachment
                                        };
                                    } else if (attachment.type) {
                                        message.attachment = attachment;
                                    }

                                    // blank text, not allowed with attachment
                                    message.text = null;

                                    // remove blank button array if specified
                                    if (message.attachment.payload.elements) {
                                        for (var e = 0; e < message.attachment.payload.elements.length; e++) {
                                            if (!message.attachment.payload.elements[e].buttons || !message.attachment.payload.elements[e].buttons.length) {
                                                delete(message.attachment.payload.elements[e].buttons);
                                            }
                                        }
                                    }
                                }
                            }

                            // handle Facebook quick replies
                            if (command.script[t].script[m].quickReply) {
                                var options = command.script[t].script[m].quickReply.quickReplies;

                                if (!message.quick_replies) {
                                    message.quick_replies = [];
                                }

                                for (var o = 0; o < options.length; o++) {
                                    message.quick_replies.push(options[o]);
                                }
                            }

                            if(command.script[t].script[m].setVar) {
                                let varVariable = command.script[t].script[m].setVar;
                                message.setVar = {
                                    key: varVariable.key,
                                    value: varVariable.value
                                }                    
                            }

                            if (command.script[t].script[m].jsonApi) {
                                message.jsonApiData = command.script[t].script[m].jsonApi;
                                const { apiUrl, requestType, propertyObjects } = message.jsonApiData;

                                message.jsonApi = function(newAttributeObjects) {
                                    const bodyObject = {};
                                    const queryObject = {};
                                    const headerObject = {};
                                    
                                    const getRequestObject = (items) => {
                                        if(!Array.isArray(items)) {
                                            return;
                                        }

                                        for(item of items) {
                                            if(item.sendIn === 'query_string') {
                                                queryObject[item.key] = item.value;
                                            } else if(item.sendIn === 'header') {
                                                headerObject[item.key] = item.value;
                                            } else {
                                                bodyObject[item.key] = item.value;
                                            }
                                        }
                                    }

                                    getRequestObject(newAttributeObjects);
                                    getRequestObject(propertyObjects);

                                    return new Promise(function (resolve, reject) {
                                        let options = {};
                                        options.uri = apiUrl;
                                        options.qs = queryObject;
                                        options.form = bodyObject;
                                        options.headers = headerObject;
                                        options.method = requestType.toUpperCase();

                                        request(options, function(err, res, body) {
                                            if (err) {
                                                return reject(err);
                                            }

                                            var json = null;

                                            try {
                                                json = JSON.parse(body);

                                                //console.log('URI', JSON.stringify(options));
                                                //console.log('RESPONSE', JSON.stringify(json));
                                            } catch(e) {
                                                console.log('Exception', e);

                                                return reject('Invalid JSON received from API');
                                            }

                                            if (!json || json == null) {
                                                reject('API response was empty or invalid JSON');
                                            } else if (json.error) {
                                                if (res.statusCode === 401) {
                                                    console.error(json.error);
                                                }

                                                reject(json.error);
                                            } else {
                                                //console.log(json);
                                                resolve(json);
                                            }
                                        });
                                    });
                                }
                            }
                            
                            if (command.script[t].script[m].gotoDialogue) {
                                message.gotoDialogue = command.script[t].script[m].gotoDialogue;
                            }
                            
                            if (command.script[t].script[m].contactHuman) {
                                message.contactHuman = command.script[t].script[m].contactHuman;
                            }

                            if (command.script[t].script[m].linkToSubscription) {
                                const user = messageCopy.user;
                                const channel = messageCopy.channel;
                                const helperApiUrl = controller.config.helper_api_uri;
                                const botToken = controller.config.studio_token;

                                message.linkToSubscription = command.script[t].script[m].linkToSubscription;
                                message.linkToSubscription.helperApiUrl = helperApiUrl;
                                
                                const loopbackUrl =
                                    message.linkToSubscription.loopbackUrl
                                    || controller.config.studio_command_uri;

                                message.linkToSubscription.loopbackUrl = loopbackUrl;

                                message.callScheduler = function (subscriptions) {
                                    return new Promise(function (resolve, reject) {
                                        let options = {};
                                        options.uri = helperApiUrl + '/api/subscriptions';
                                        options.form = { subscriptions, apiUrl: loopbackUrl, botToken, user, channel };
                                        options.method = 'POST';

                                        request(options, function (err, res, body) {
                                            if (err) {
                                                return reject(err);
                                            }

                                            var json = null;

                                            try {
                                                json = JSON.parse(body);

                                            } catch (e) {
                                                console.log('Exception', e);

                                                return reject('Invalid JSON received from API');
                                            }

                                            if (!json || json == null) {
                                                reject('API response was empty or invalid JSON');
                                            } else if (json.error) {
                                                console.error(json.error);

                                                reject(json.error);
                                            } else {
                                                console.log('response from subscription adding api', json);
                                                resolve(json);
                                            }
                                        });
                                    });
                                }
                            }

                            // handle Facebook quick replies that are embedded in question options
                            if (command.script[t].script[m].collect) {

                                let options = command.script[t].script[m].collect.options || [];
                                if (options.length > 0) {
                                    for (let o = 0; o < options.length; o++) {
                                        if (options[o].fb_quick_reply) {
                                            if (!message.quick_replies) {
                                                message.quick_replies = [];
                                            }
                                            message.quick_replies.push({
                                                title: options[o].pattern,
                                                payload: options[o].fb_quick_reply_payload,
                                                image_url: options[o].fb_quick_reply_image_url,
                                                content_type: options[o].fb_quick_reply_content_type,
                                            });
                                        }
                                    }
                                }
                            }

                            if (command.script[t].script[m].action) {
                                message.action = command.script[t].script[m].action;
                                if (command.script[t].script[m].execute) {
                                    message.execute = command.script[t].script[m].execute;
                                }
                            }

                            // handle meta data
                            if (command.script[t].script[m].meta) {
                                for (let a = 0; a < command.script[t].script[m].meta.length; a++) {
                                    message[command.script[t].script[m].meta[a].key] = command.script[t].script[m].meta[a].value;
                                }
                            }

                             if (command.script[t].script[m].collect) {
                                // this is a question message
                                let capture_options = {};
                                let handlers = [];
                                let options = command.script[t].script[m].collect.options || [];
                                if (command.script[t].script[m].collect.key) {
                                    capture_options.key = command.script[t].script[m].collect.key;
                                    capture_options.validation = command.script[t].script[m].collect.validation;
                                    capture_options.validationRegex = command.script[t].script[m].collect.validationRegex;
                                    capture_options.validationMessage = command.script[t].script[m].collect.validationMessage;
                                    capture_options.checkIfAttributeExists = command.script[t].script[m].collect.checkIfAttributeExists;
                                }
                                
                                const cancelInputString = '##cancel**input**loop##';
                                const cancelButtonName = command.script[t].script[m].collect.cancelButtonName;
                                const allowCancelingConversation = command.script[t].script[m].collect.allowCancelingConversation;

                                if (command.script[t].script[m].collect.multiple) {
                                    capture_options.multiple = true;
                                }

                                let default_found = false;
                                for (let o = 0; o < options.length; o++) {
                                    let handler = makeHandler(options[o], capture_options);
                                    handlers.push(handler);
                                    if (options[o].default) {
                                        default_found = true;
                                    }
                                }

                                // make sure there is a default
                                if (!default_found) {
                                    handlers.push({
                                        default: true,
                                        callback: function(r, c) {
                                            runHooks(
                                                answer_hooks[command.command] ? answer_hooks[command.command].slice() : [],
                                                convo,
                                                function(convo) {
                                                    const userResponse = c.responses[capture_options.key].text;
                                                    
                                                    if (userResponse === cancelInputString) {
                                                        c.stop();

                                                        return;
                                                    }

                                                    if (!capture_options.validationRegex) {
                                                        c.setVar(capture_options.key, userResponse);
                                                        controller.storage.users.saveAttribute(
                                                            {
                                                                user_id: messageCopy.user,
                                                                attribute: {
                                                                    key: capture_options.key,
                                                                    value: userResponse
                                                                }
                                                            }
                                                        );
                                                        c.next();

                                                        return;
                                                    }

                                                    const validationRegex = new RegExp(capture_options.validationRegex);

                                                    if (capture_options.key.toLowerCase() !== 'none' && !validationRegex.test(userResponse)) {
                                                        convo.messages.unshift(convo.lastMessage);
                                                        convo.addMessage({ text: capture_options.validationMessage }, topic, 1);
                                                    } else {
                                                        c.setVar(capture_options.key, userResponse);
                                                        controller.storage.users.saveAttribute({
                                                            user_id: messageCopy.user,
                                                            attribute: {
                                                                key: capture_options.key,
                                                                value: userResponse
                                                            }
                                                        });
                                                    }
                                                    c.next();
                                                }
                                            );
                                        }
                                    });
                                }
                                 
                                 if(allowCancelingConversation) {
                                    const text = message.text;
                                    
                                    message.attachment = {
                                        type: 'template',
                                        payload: {
                                            text,
                                            buttons: [{
                                                payload: cancelInputString,
                                                title: cancelButtonName || 'cancel',
                                                type: 'postback'
                                            }],
                                            template_type: 'button'
                                        }
                                    };

                                    delete message.text;
                                }

                                 if (capture_options.checkIfAttributeExists) {
                                    const existingVar = convo.getVar(capture_options.key);

                                    if (existingVar === undefined || existingVar === null) {
                                        convo.addQuestion(
                                            message,
                                            handlers,
                                            capture_options,
                                            topic
                                        );
                                    } else {
                                        // console.log('....attribute already exists.......', existingVar);
                                    }
                                } else {
                                    convo.addQuestion(message, handlers, capture_options, topic);
                                }
                            } else if (command.script[t].script[m].quickReply) {
                                const capture_options = {};
                                const previousMessage = convo.messages[convo.messages.length - 1];
                                const { saveToAttribute, dialogueTriggers, quickReplies } = command.script[t].script[m].quickReply;

                                const validPayloads = [];

                                if(quickReplies && quickReplies.length) {
                                    for(const { payload, title } of quickReplies) {
                                        if(payload) {
                                            validPayloads.push(payload);
                                        }
                                        if(title) {
                                            validPayloads.push(title);
                                        }
                                    }
                                }

                                capture_options.key = 'quickReplyResponse';

                                const replyHandlers = [{
                                    default: true,
                                    callback: function (r, c) {
                                        runHooks(
                                            answer_hooks[command.command] ? answer_hooks[command.command].slice() : [],
                                            convo,
                                            function (convo) {
                                                const userResponseText = c.responses[capture_options.key].text;
                                                const userResponsePayload =
                                                    c.responses[capture_options.key].quick_reply
                                                    && c.responses[capture_options.key].quick_reply.payload;
                                                
                                                const userResponse = userResponseText || userResponsePayload;
                                                
                                                if(validPayloads.indexOf(userResponse) === -1) {
                                                    c.stop();

                                                    const message = {};
                                                    message.user = message.channel = previousMessage.channel;
                                                    
                                                    message.text = userResponse;

                                                    return controller.trigger('message_received', [bot, message]);
                                                }

                                                if(saveToAttribute) {
                                                    c.setVar(saveToAttribute, userResponseText);
                                                    
                                                    controller.storage.users.saveAttribute({
                                                        user_id:
                                                            messageCopy.user,
                                                        attribute: {
                                                            key: saveToAttribute,
                                                            value: userResponseText
                                                        }
                                                    });
                                                }
                                                
                                                c.next();
                                                
                                                if (dialogueTriggers && dialogueTriggers.indexOf(userResponsePayload) > -1) {
                                                    const message = {};
                                                    message.user = message.channel = previousMessage.channel;
                                                    
                                                    message.text = userResponsePayload;
                                                    
                                                    controller.trigger('custom_trigger', [bot, message]);
                                                }
                                            }
                                        );
                                    }
                                }];
                                
                                if (previousMessage.attachment) {
                                    const type = previousMessage.attachment.type;

                                    if (type === 'template' || type === 'image') {
                                        previousMessage.handler = replyHandlers;
                                        previousMessage.capture_options = capture_options;
                                        previousMessage.quick_replies = message.quick_replies;
                                    }
                                } else if(previousMessage.text) {
                                    previousMessage.handler = replyHandlers;
                                    previousMessage.capture_options = capture_options;
                                    previousMessage.quick_replies = message.quick_replies;
                                }
                            } else if(command.script[t].script[m].shareLocation) {
                                const capture_options = {};
                                const shareLocationMessage = command.script[t].script[m].shareLocation.instructionMessage;
                                capture_options.key = 'locationResponse';

                                const replyHandlers = [{
                                    default: true,
                                    callback: function (r, c) {
                                        runHooks(
                                            answer_hooks[command.command] ? answer_hooks[command.command].slice() : [],
                                            convo,
                                            async function (convo) {
                                                const userResponse = c.responses[capture_options.key];
                                                const responseAttachment = userResponse && userResponse.attachments && userResponse.attachments[0];

                                                if(!responseAttachment) {
                                                    console.error('response attachment not received from send location button');

                                                    const responseText = userResponse.text;
                                                    const responseUser = userResponse.user || userResponse.channel;

                                                    if(responseText && responseUser) {
                                                        c.stop();
                                                        const message = {};
                                                        message.text = responseText;
                                                        message.user = message.channel = responseUser;
                                                        
                                                        return controller.trigger('message_received', [bot, message]);
                                                    }

                                                    return c.next();
                                                }

                                                const mapUrl = responseAttachment.url;
                                                const latitude = responseAttachment.payload && responseAttachment.payload.coordinates && responseAttachment.payload.coordinates.lat;
                                                const longitude = responseAttachment.payload && responseAttachment.payload.coordinates && responseAttachment.payload.coordinates.long;

                                                let isSaveMapUrl, isSaveLatLong = false;

                                                if(mapUrl) {
                                                    isSaveMapUrl = true;
                                                    c.setVar('user_map_url', mapUrl);
                                                } else {
                                                    console.error('map url could not be extracted from send location response');
                                                }

                                                if(latitude && longitude) {
                                                    isSaveLatLong = true;
                                                    c.setVar('user_latitude', latitude);
                                                    c.setVar('user_longitude', longitude);
                                                } else {
                                                    console.error('latitude and longitude could not be extracted from send location response');
                                                }

                                                c.next();

                                                if(isSaveMapUrl) {
                                                    await controller.storage.users.saveAttribute({
                                                        user_id:
                                                            messageCopy.user,
                                                        attribute: {
                                                            key: 'user_map_url',
                                                            value: mapUrl
                                                        }
                                                    });
                                                }

                                                if(isSaveLatLong) {
                                                    await controller.storage.users.saveAttribute({
                                                        user_id:
                                                            messageCopy.user,
                                                        attribute: {
                                                            key: 'user_latitude',
                                                            value: latitude
                                                        }
                                                    });
                                                    await controller.storage.users.saveAttribute({
                                                        user_id:
                                                            messageCopy.user,
                                                        attribute: {
                                                            key: 'user_longitude',
                                                            value: longitude
                                                        }
                                                    });
                                                }
                                            }
                                        );
                                    }
                                }];
                                
                                message.quick_replies = [{ 'content_type': 'location' }];
                                message.text = shareLocationMessage || 'Press the button below to share your location';
                                message.capture_options = capture_options;
                                message.handler = replyHandlers;

                                convo.addMessage(message, topic);
                            } else {
                                // this is a simple message
                                convo.addMessage(message, topic);
                            }
                        } // if !conditional
                    }

                    // add thread hooks if they have been defined.
                    if (thread_hooks[command.command] && thread_hooks[command.command][topic]) {
                        for (var h = 0; h < thread_hooks[command.command][topic].length; h++) {
                            convo.beforeThread(topic, thread_hooks[command.command][topic][h]);
                        }
                    }

                }


                resolve(convo);
            });
        });
    };

    /* ----------------------------------------------------------------
     * Botkit Studio Stats
     * The features below this line pertain to communicating with Botkit Studio's
     * stats feature.
     * ---------------------------------------------------------------- */



    function statsAPI(bot, options, message) {
        var _STUDIO_STATS_API = controller.config.studio_stats_uri || 'https://stats.botkit.ai';
        options.uri = _STUDIO_STATS_API + '/api/v1/stats';

        return new Promise(function(resolve, reject) {

            var headers = {
                'content-type': 'application/json',
            };

            if (bot.config && bot.config.studio_token) {
                options.uri = options.uri + '?access_token=' + bot.config.studio_token;
            } else if (controller.config && controller.config.studio_token) {
                options.uri = options.uri + '?access_token=' + controller.config.studio_token;
            } else {
                // do nothing - making an unathenticated request to the stats api...
            }

            options.headers = headers;
            var now = new Date();
            if (options.now) {
                now = options.now;
            }


            var stats_body = {};
            stats_body.botHash = botHash(bot);
            if (bot.type == 'slack' && bot.team_info) {
                stats_body.team = md5(bot.team_info.id);
            }

            if (bot.type == 'ciscospark' && message && message.raw_message && message.raw_message.orgId) {
                stats_body.team = md5(message.raw_message.orgId);
            }

            if (bot.type == 'teams' && bot.config.team) {
                stats_body.team = md5(bot.config.team);
            }

            stats_body.channel = options.form.channel;
            stats_body.user = options.form.user;
            stats_body.type = options.form.type;
            stats_body.time = now;
            stats_body.meta = {};
            stats_body.meta.user = options.form.user;
            stats_body.meta.channel = options.form.channel;
            if (options.form.final_thread) {
                stats_body.meta.final_thread = options.form.final_thread;
            }
            if (bot.botkit.config.clientId) {
                stats_body.meta.app = md5(bot.botkit.config.clientId);
            }
            stats_body.meta.timestamp = options.form.timestamp;
            stats_body.meta.bot_type = options.form.bot_type;
            stats_body.meta.conversation_length = options.form.conversation_length;
            stats_body.meta.status = options.form.status;
            stats_body.meta.type = options.form.type;
            stats_body.meta.command = options.form.command;
            options.form = stats_body;
            stats_body.meta.timestamp = options.now || now;
            request(options, function(err, res, body) {
                if (err) {
                    return reject(err);
                }

                var json = null;

                try {
                    json = JSON.parse(body);
                } catch (e) {}

                if (!json || json == null) {
                    return reject('Response from Botkit Studio API was empty or invalid JSON');
                } else if (json.error) {
                    if (res.statusCode === 401) {
                        console.error(json.error);
                    }
                    return reject(json.error);
                } else {
                    resolve(json);
                }
            });
        });
    }

    /* generate an anonymous hash to uniquely identify this bot instance */
    function botHash(bot) {
        var x = '';
        switch (bot.type) {
            case 'slack':
                if (bot.config.token) {
                    x = md5(bot.config.token);
                } else {
                    x = 'non-rtm-bot';
                }
            break;

            case 'teams':
                x = md5(bot.identity.id);
            break;

            case 'fb':
                x = md5(bot.botkit.config.access_token);
            break;

            case 'twilioipm':
                x = md5(bot.config.TWILIO_IPM_SERVICE_SID);
            break;

            case 'twiliosms':
                x = md5(bot.botkit.config.account_sid);
            break;


            case 'ciscospark':
                x = md5(bot.botkit.config.ciscospark_access_token);
            break;

            default:
                x = 'unknown-bot-type';
            break;
        }
        return x;
    };


    /* Every time a bot spawns, Botkit calls home to identify this unique bot
     * so that the maintainers of Botkit can measure the size of the installed
     * userbase of Botkit-powered bots. */
    if (!controller.config.stats_optout) {

        controller.on('spawned', function(bot) {

            var data = {
                type: 'spawn',
                bot_type: bot.type,
            };
            controller.trigger('stats:spawned', bot);
            return statsAPI(bot, {
                method: 'post',
                form: data,
            });
        });


        controller.on('heard_trigger', function(bot, keywords, message) {
            var data = {
                type: 'heard_trigger',
                user: md5(message.user),
                channel: md5(message.channel),
                bot_type: bot.type,
            };
            controller.trigger('stats:heard_trigger', message);
            return statsAPI(bot, {
                method: 'post',
                form: data,
            }, message);
        });

        controller.on('command_triggered', function(bot, message, command) {
            var data = {
                type: 'command_triggered',
                now: message.now,
                user: md5(message.user),
                channel: md5(message.channel),
                command: command.command,
                timestamp: command.created,
                bot_type: bot.type,
            };
            controller.trigger('stats:command_triggered', message);
            return statsAPI(bot, {
                method: 'post',
                form: data,
            }, message);
        });

        controller.on('remote_command_end', function(bot, message, command, convo) {
            var data = {
                now: message.now,
                user: md5(message.user),
                channel: md5(message.channel),
                command: command.command,
                timestamp: command.created,
                conversation_length: convo.lastActive - convo.startTime,
                status: convo.status,
                type: 'remote_command_end',
                final_thread: convo.thread,
                bot_type: bot.type,
            };
            controller.trigger('stats:remote_command_end', message);
            return statsAPI(bot, {
                method: 'post',
                form: data,
            }, message);

        });

    }

};
