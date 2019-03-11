/**
 * This is a module that makes a bot
 * It expects to receive messages via the botkit.ingest function
 **/
var mustache = require('mustache');
var simple_storage = require(__dirname + '/storage/simple_storage.js');
var ConsoleLogger = require(__dirname + '/console_logger.js');
var LogLevels = ConsoleLogger.LogLevels;
var ware = require('ware');
var clone = require('clone');
var fs = require('fs');
var studio = require('./Studio.js');
var os = require('os');
var async = require('async');
var PKG_VERSION = require('../package.json').version;
var express = require('express');
var bodyParser = require('body-parser');

function Botkit(configuration) {
    var botkit = {
        events: {}, // this will hold event handlers
        config: {}, // this will hold the configuration
        tasks: [],
        taskCount: 0,
        convoCount: 0,
        my_version: null,
        my_user_agent: null,
        memory_store: {
            users: {},
            channels: {},
            teams: {}
        },
        tickDelay: 1500
    };

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    // TODO: externalize this into some sort of utterances.json file
    botkit.utterances = {
        yes: new RegExp(/^(yes|yea|yup|yep|ya|sure|ok|y|yeah|yah)/i),
        no: new RegExp(/^(no|nah|nope|n)/i),
        quit: new RegExp(/^(quit|cancel|end|stop|done|exit|nevermind|never mind)/i)
    };

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    // define some middleware points where custom functions
    // can plug into key points of botkits process
    botkit.middleware = {
        spawn: ware(),
        ingest: ware(),
        normalize: ware(),
        categorize: ware(),
        receive: ware(),
        heard: ware(), // best place for heavy i/o because fewer messages
        triggered: ware(), // like heard, but for other events
        capture: ware(),
        format: ware(),
        send: ware(),
        conversationStart: ware(),
        conversationEnd: ware()
    };

    // list of events to exclude from conversations
    // useful to exclude things like delivery confirmations, and other behind the scenes events
    botkit.excludedEvents = [];

    // add a single event or an array of events to be excluded from the conversations
    botkit.excludeFromConversations = function(event) {
        if (Array.isArray(event)) {
            for (var e = 0; e < event.length; e++) {
                botkit.excludedEvents.push(event[e]);
            }
        } else {
            botkit.excludedEvents.push(event);
        }
    };

    botkit.ingest = function(bot, payload, source) {
        // keep an unmodified copy of the message
        payload.raw_message = clone(payload);

        payload._pipeline = {
            stage: 'ingest'
        };

        botkit.middleware.ingest.run(bot, payload, source, function(err, bot, payload, source) {
            if (err) {
                console.error('An error occured in the ingest middleware: ', err);
                return;
            }
            botkit.normalize(bot, payload);
        });
    };

    botkit.normalize = function(bot, payload) {
        payload._pipeline.stage = 'normalize';
        botkit.middleware.normalize.run(bot, payload, function(err, bot, message) {
            if (err) {
                console.error('An error occured in the normalize middleware: ', err);
                return;
            }

            if (!message.type) {
                message.type = 'message_received';
            }
            botkit.categorize(bot, message);
        });
    };

    botkit.categorize = function(bot, message) {
        message._pipeline.stage = 'categorize';
        botkit.middleware.categorize.run(bot, message, function(err, bot, message) {
            if (err) {
                console.error('An error occured in the categorize middleware: ', err);
                return;
            }

            botkit.receiveMessage(bot, message);
        });
    };

    botkit.receiveMessage = function(bot, message) {
        message._pipeline.stage = 'receive';
        botkit.middleware.receive.run(bot, message, function(err, bot, message) {
            if (err) {
                console.error('An error occured in the receive middleware: ', err);
                return;
            } else {
                botkit.debug('RECEIVED MESSAGE');
                bot.findConversation(message, function(convo) {
                    if (convo) {
                        convo.handle(message);
                    } else {
                        botkit.trigger(message.type, [bot, message]);
                    }
                });
            }
        });
    };

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    function Conversation(task, message) {
        this.messages = [];
        this.sent = [];
        this.transcript = [];

        this.context = {
            user: message.user,
            channel: message.channel,
            bot: task.bot,
            script_name: message.script_name || null,
            script_id: message.script_id || null
        };

        this.events = {};

        this.vars = {};

        this.threads = {};
        this.thread = null;

        this.status = 'new';
        this.task = task;
        this.source_message = message;
        this.handler = null;
        this.responses = {};
        this.capture_options = {};
        this.startTime = new Date();
        this.lastActive = new Date();
        /** will be pointing to a callback which will be called after timeout,
         * conversation will be not be ended and should be taken care by callback
         */
        this.timeOutHandler = null;

        this.collectResponse = function(key, value) {
            this.responses[key] = value;
        };

        this.capture = function(response, cb) {
            var that = this;
            var capture_key = this.sent[this.sent.length - 1].text;
            botkit.middleware.capture.run(that.task.bot, response, that, function(err, bot, response, convo) {
                if (response.text) {
                    response.text = response.text.trim();
                } else {
                    response.text = '';
                }

                if (that.capture_options.key != undefined) {
                    capture_key = that.capture_options.key;
                }

                // capture the question that was asked
                // if text is an array, get 1st
                if (typeof that.sent[that.sent.length - 1].text == 'string') {
                    response.question = that.sent[that.sent.length - 1].text;
                } else if (Array.isArray(that.sent[that.sent.length - 1].text)) {
                    response.question = that.sent[that.sent.length - 1].text[0];
                } else {
                    response.question = '';
                }

                if (that.capture_options.multiple) {
                    if (!that.responses[capture_key]) {
                        that.responses[capture_key] = [];
                    }
                    that.responses[capture_key].push(response);
                } else {
                    that.responses[capture_key] = response;
                }

                if (cb) cb(response);
            });
        };

        this.handle = function(message) {
            var that = this;
            this.lastActive = new Date();
            this.transcript.push(message);
            botkit.debug('HANDLING MESSAGE IN CONVO', message);
            // do other stuff like call custom callbacks
            if (this.handler) {
                this.capture(message, function(message) {
                    // if the handler is a normal function, just execute it!
                    // NOTE: anyone who passes in their own handler has to call
                    // convo.next() to continue after completing whatever it is they want to do.
                    if (typeof that.handler == 'function') {
                        that.handler(message, that);
                    } else {
                        // handle might be a mapping of keyword to callback.
                        // lets see if the message matches any of the keywords
                        var match,
                            patterns = that.handler;
                        for (var p = 0; p < patterns.length; p++) {
                            if (patterns[p].pattern && botkit.hears_test([patterns[p].pattern], message)) {
                                botkit.middleware.heard.run(that.task.bot, message, function(err, bot, message) {
                                    patterns[p].callback(message, that);
                                });
                                return;
                            }
                        }

                        // none of the messages matched! What do we do?
                        // if a default exists, fire it!
                        for (var p = 0; p < patterns.length; p++) {
                            if (patterns[p].default) {
                                botkit.middleware.heard.run(that.task.bot, message, function(err, bot, message) {
                                    patterns[p].callback(message, that);
                                });
                                return;
                            }
                        }
                    }
                });
            } else {
                // do nothing
            }
        };

        this.setVar = function(field, value, isPersist) {
            if (!this.vars) {
                this.vars = {};
            }

            this.vars[field] = value;

            if (!isPersist) {
                return;
            }

            const storage = this.task.botkit.storage;

            if (!storage) {
                return;
            }

            return storage.users.saveAttribute({
                user_id: this.context.user,
                attribute: {
                    key: field,
                    value
                }
            });
        };

        this.getVar = function(field, getFromDb) {
            if (getFromDb) {
                const storage = this.task.botkit.storage;

                if (!storage) {
                    console.error('Cannot access database storage to read user attribute');

                    return undefined;
                }

                return storage.users
                    .getLatestAttribute({ userId: this.context.user, attributeName: field })
                    .then((attributeObject) => attributeObject && attributeObject.value)
                    .catch((error) => {
                        console.error(error);

                        return undefined;
                    });
            }

            if (!this.vars) {
                return undefined;
            }

            return this.vars[field];
        };

        this.activate = function() {
            botkit.middleware.conversationStart.run(this.task.bot, this, function(err, bot, convo) {
                convo.status = 'active';
                convo.task.trigger('conversationStarted', [convo]);
                convo.task.botkit.trigger('conversationStarted', [bot, convo]);
            });
        };

        /**
         * active includes both ACTIVE and ENDING
         * in order to allow the timeout end scripts to play out
         **/
        this.isActive = function() {
            return this.status == 'active' || this.status == 'ending';
        };

        this.deactivate = function() {
            this.status = 'inactive';
        };

        this.say = function(message) {
            this.addMessage(message);
        };

        this.addConditional = function(condition, thread) {
            condition.type = 'conditional';
            if (!this.threads[thread]) {
                this.threads[thread] = [];
            }
            this.threads[thread].push(condition);

            // this is the current topic, so add it here as well
            if (this.thread == thread) {
                this.messages.push(condition);
            }
        };

        this.handleAction = function(condition) {
            // condition.action
            // if (condition.action=='execute_script')
            // condition.execute will be present
            var that = this;
            switch (condition.action) {
                case 'execute_script':
                    if (condition.execute) {
                        var script = condition.execute.script;
                        var thread = condition.execute.thread;

                        // this will stop the conversation from automatically ending while the transition takes place
                        that.status = 'transitioning';

                        botkit.studio
                            .get(
                                that.context.bot,
                                script,
                                that.source_message.user,
                                that.source_message.channel,
                                that.source_message
                            )
                            .then(function(new_convo) {
                                that.context.transition_to = new_convo.context.script_name || null;
                                that.context.transition_to_id = new_convo.context.script_id || null;
                                that.stop('transitioning to ' + script);

                                // copy any question responses
                                for (var key in that.responses) {
                                    new_convo.responses[key] = that.responses[key];
                                }

                                // copy old variables into new conversation
                                for (var key in that.vars) {
                                    new_convo.setVar(key, that.vars[key]);
                                }

                                new_convo.context.transition_from = that.context.script_name || null;
                                new_convo.context.transition_from_id = that.context.script_id || null;

                                // if thread == default, this is the normal behavior and we don't need to call gotoThread
                                // in fact, calling gotoThread will cause it to override behaviors in the scripts `before` hook.
                                if (thread != 'default') {
                                    new_convo.gotoThread(thread);
                                }

                                new_convo.activate();
                            })
                            .catch(function(err) {
                                console.error('Error executing script transition:', err);
                            });
                    }
                    break;

                case 'next':
                    that.next();
                    break;
                case 'repeat':
                    that.repeat();
                    that.next();
                    break;
                case 'stop':
                    that.stop();
                    break;
                case 'wait':
                    that.silentRepeat();
                    break;
                case 'complete':
                    that.stop('completed');
                    break;
                case 'timeout':
                    that.stop('timeout');
                    break;
                default:
                    if (typeof condition.action == 'function') {
                        condition.action(that);
                    } else {
                        that.gotoThread(condition.action);
                    }
                    break;
            }
        };

        this.evaluateCondition = function(condition) {
            var that = this;
            var left = this.replaceTokens(condition.left);
            var right = this.replaceTokens(condition.right);
            var passed = false;
            switch (condition.test) {
                case 'equals':
                    if (left == right) {
                        // immediately move on!
                        passed = true;
                    }
                    break;
                case '!equals':
                    if (left != right) {
                        // immediately move on!
                        passed = true;
                    }
                    break;
                case 'exists':
                    if (left && left != '') {
                        // immediately move on!
                        passed = true;
                    }
                    break;
                case '!exists':
                    if (!left || left == '') {
                        // immediately move on!
                        passed = true;
                    }
                    break;
            }

            if (passed) {
                that.handleAction(condition);
            }

            this.tick();
        };

        this.sayFirst = function(message) {
            if (typeof message == 'string') {
                message = {
                    text: message,
                    channel: this.source_message.channel
                };
            } else {
                message.channel = this.source_message.channel;
            }
            this.messages.unshift(message);
        };

        this.on = function(event, cb) {
            botkit.debug('Setting up a handler for', event);
            var events = event.split(/\,/g);
            for (var e in events) {
                if (!this.events[events[e]]) {
                    this.events[events[e]] = [];
                }
                this.events[events[e]].push(cb);
            }
            return this;
        };

        this.trigger = function(event, data) {
            if (this.events[event]) {
                for (var e = 0; e < this.events[event].length; e++) {
                    var res = this.events[event][e].apply(this, data);
                    if (res === false) {
                        return;
                    }
                }
            } else {
            }
        };

        // proceed to the next message after waiting for an answer
        this.next = function() {
            this.handler = null;
        };

        this.repeat = function() {
            if (this.sent.length) {
                // is this the last message in the queue? then just push it on again
                // if not, sayFirst it to the front so it doesn't repeat AFTER other messages
                if (!this.messages.length) {
                    this.messages.push(this.sent[this.sent.length - 1]);
                } else {
                    this.sayFirst(this.sent[this.sent.length - 1]);
                }
            } else {
                // do nothing
            }
        };

        this.silentRepeat = function() {
            return;
        };

        this.addQuestion = function(message, cb, capture_options, thread) {
            if (typeof message == 'string') {
                message = {
                    text: message,
                    channel: this.source_message.channel
                };
            } else {
                message.channel = this.source_message.channel;
            }

            if (capture_options) {
                message.capture_options = capture_options;
            }

            message.handler = cb;
            this.addMessage(message, thread);
        };

        this.ask = function(message, cb, capture_options) {
            this.addQuestion(message, cb, capture_options, this.thread || 'default');
        };

        this.addMessage = function(message, thread, unshiftMessage = 0) {
            if (!thread) {
                thread = this.thread;
            }
            if (typeof message == 'string') {
                message = {
                    text: message,
                    channel: this.source_message.channel
                };
            } else {
                message.channel = this.source_message.channel;
            }

            if (!this.threads[thread]) {
                this.threads[thread] = [];
            }
            if (unshiftMessage) {
                this.threads[thread].unshift(message);
            } else {
                this.threads[thread].push(message);
            }

            // this is the current topic, so add it here as well
            if (this.thread == thread) {
                if (unshiftMessage) {
                    this.messages.unshift(message);
                } else {
                    this.messages.push(message);
                }
            }
        };

        // how long should the bot wait while a user answers?
        this.setTimeout = function(timeout) {
            this.task.timeLimit = timeout;
        };

        // For backwards compatibility, wrap gotoThread in its previous name
        this.changeTopic = function(topic) {
            this.gotoThread(topic);
        };

        this.hasThread = function(thread) {
            return this.threads[thread] != undefined;
        };

        this.transitionTo = function(thread, message) {
            // add a new transition thread
            // add this new message to it
            // set that message action to execute the actual transition
            // then change threads to transition thread

            var num = 1;
            while (this.hasThread('transition_' + num)) {
                num++;
            }

            var threadname = 'transition_' + num;

            if (typeof message == 'string') {
                message = {
                    text: message,
                    action: thread
                };
            } else {
                message.action = thread;
            }

            this.addMessage(message, threadname);

            this.gotoThread(threadname);
        };

        this.beforeThread = function(thread, callback) {
            if (!this.before_hooks) {
                this.before_hooks = {};
            }

            if (!this.before_hooks[thread]) {
                this.before_hooks[thread] = [];
            }
            this.before_hooks[thread].push(callback);
        };

        this.gotoThread = function(thread) {
            var that = this;
            that.next_thread = thread;
            that.processing = true;

            var makeChange = function() {
                if (!that.hasThread(that.next_thread)) {
                    if (that.next_thread == 'default') {
                        that.threads[that.next_thread] = [];
                    } else {
                        botkit.debug('WARN: gotoThread() to an invalid thread!', thread);
                        that.stop('unknown_thread');
                        return;
                    }
                }

                that.thread = that.next_thread;
                that.messages = that.threads[that.next_thread].slice();

                that.handler = null;
                that.processing = false;
            };

            if (that.before_hooks && that.before_hooks[that.next_thread]) {
                // call any beforeThread hooks in sequence
                async.eachSeries(
                    this.before_hooks[that.next_thread],
                    function(before_hook, next) {
                        before_hook(that, next);
                    },
                    function(err) {
                        if (!err) {
                            makeChange();
                        }
                    }
                );
            } else {
                makeChange();
            }
        };

        this.combineMessages = function(messages) {
            if (!messages) {
                return '';
            }

            if (Array.isArray(messages) && !messages.length) {
                return '';
            }

            if (messages.length > 1) {
                var txt = [];
                var last_user = null;
                var multi_users = false;
                last_user = messages[0].user;
                for (var x = 0; x < messages.length; x++) {
                    if (messages[x].user != last_user) {
                        multi_users = true;
                    }
                }
                last_user = '';
                for (var x = 0; x < messages.length; x++) {
                    if (multi_users && messages[x].user != last_user) {
                        last_user = messages[x].user;
                        if (txt.length) {
                            txt.push('');
                        }
                        txt.push('<@' + messages[x].user + '>:');
                    }
                    txt.push(messages[x].text);
                }
                return txt.join('\n');
            } else {
                if (messages.length) {
                    return messages[0].text;
                } else {
                    return messages.text;
                }
            }
        };

        this.getResponses = function() {
            var res = {};
            for (var key in this.responses) {
                res[key] = {
                    question: this.responses[key].length
                        ? this.responses[key][0].question
                        : this.responses[key].question,
                    key: key,
                    answer: this.extractResponse(key)
                };
            }
            return res;
        };

        this.getResponsesAsArray = function() {
            var res = [];
            for (var key in this.responses) {
                res.push({
                    question: this.responses[key].length
                        ? this.responses[key][0].question
                        : this.responses[key].question,
                    key: key,
                    answer: this.extractResponse(key)
                });
            }
            return res;
        };

        this.extractResponses = function() {
            var res = {};
            for (var key in this.responses) {
                res[key] = this.extractResponse(key);
            }
            return res;
        };

        this.extractResponse = function(key) {
            return this.combineMessages(this.responses[key]);
        };

        this.replaceAttachmentTokens = function(attachments) {
            if (attachments && attachments.length) {
                for (var a = 0; a < attachments.length; a++) {
                    for (var key in attachments[a]) {
                        if (typeof attachments[a][key] == 'string') {
                            attachments[a][key] = this.replaceTokens(attachments[a][key]);
                        } else {
                            attachments[a][key] = this.replaceAttachmentTokens(attachments[a][key]);
                        }
                    }
                }
            } else {
                for (var a in attachments) {
                    if (typeof attachments[a] == 'string') {
                        attachments[a] = this.replaceTokens(attachments[a]);
                    } else {
                        attachments[a] = this.replaceAttachmentTokens(attachments[a]);
                    }
                }
            }

            return attachments;
        };

        this.replaceTokens = function(text) {
            var vars = {
                identity: this.task.bot.identity,
                responses: this.extractResponses(),
                origin: this.task.source_message,
                vars: this.vars
            };

            var rendered = '';

            try {
                rendered = mustache.render(text, vars);
            } catch (err) {
                botkit.log('Error in message template. Mustache failed with error: ', err);
                rendered = text;
            }

            return rendered;
        };

        this.stop = function(status) {
            this.handler = null;
            this.messages = [];
            this.status = status || 'stopped';
            botkit.debug('Conversation is over with status ' + this.status);
            this.task.conversationEnded(this);
        };

        // was this conversation successful?
        // return true if it was completed
        // otherwise, return false
        // false could indicate a variety of failed states:
        // manually stopped, timed out, etc
        this.successful = function() {
            // if the conversation is still going, it can't be successful yet
            if (this.isActive()) {
                return false;
            }

            if (this.status == 'completed') {
                return true;
            } else {
                return false;
            }
        };

        this.cloneMessage = function(message) {
            // clone this object so as not to modify source
            var outbound = clone(message);

            if (typeof message.text == 'string') {
                outbound.text = this.replaceTokens(message.text);
            } else if (message.text) {
                outbound.text = this.replaceTokens(message.text[Math.floor(Math.random() * message.text.length)]);
            }

            if (outbound.attachments) {
                outbound.attachments = this.replaceAttachmentTokens(outbound.attachments);
            }

            if (outbound.attachment) {
                // pick one variation of the message text at random
                if (outbound.attachment.payload.text && typeof outbound.attachment.payload.text != 'string') {
                    outbound.attachment.payload.text = this.replaceTokens(
                        outbound.attachment.payload.text[
                            Math.floor(Math.random() * outbound.attachment.payload.text.length)
                        ]
                    );
                }
                outbound.attachment = this.replaceAttachmentTokens([outbound.attachment])[0];
            }

            if (this.messages.length && !message.handler) {
                outbound.continue_typing = true;
            }

            if (typeof message.attachments == 'function') {
                outbound.attachments = message.attachments(this);
            }

            return outbound;
        };

        this.cloneTriggerMessage = function(sourceMessage) {
            const message = { ...sourceMessage };

            delete message.script_id;
            delete message.script_name;
            delete message.raw_message;
            delete message.original_message;

            return message;
        };

        this.onTimeout = function(handler) {
            if (typeof handler == 'function') {
                this.timeOutHandler = handler;
            } else {
                botkit.debug('Invalid timeout function passed to onTimeout');
            }
        };

        this.lastMessage = {};

        this.evaluateBotOperationEntity = async function(entity) {
            if (!entity) {
                return undefined;
            }

            switch ((entity.type || '').toLowerCase()) {
                case 'text': {
                    return entity.textValue;
                }

                case 'number': {
                    const value = Number(entity.numberValue);

                    return Number.isNaN(value) ? undefined : value;
                }

                case 'date': {
                    const parsedDate = Date.parse(entity.dateValue);

                    if (!parsedDate) {
                        return undefined;
                    }

                    return new Date(parsedDate);
                }

                case 'keyword': {
                    if ((entity.keyword || '').toLowerCase() === 'currenttime') {
                        return new Date();
                    }

                    return undefined;
                }

                case 'attribute': {
                    try {
                        const attributeName = entity.attribute && entity.attribute.name;
                        let value = this.getVar(attributeName);

                        if (!value) {
                            value = await this.getVar(attributeName, true);
                        }

                        return value;
                    } catch (error) {
                        console.error(error);

                        return undefined;
                    }
                }

                default: {
                    return undefined;
                }
            }
        };

        this.getDateObjectOrNull = function(dateValue) {
            if (!dateValue) {
                return null;
            }

            const valueType = Object.prototype.toString.call(dateValue);

            if (valueType === '[object Date]') {
                return dateValue;
            }

            if (valueType === '[object Number]' || valueType === '[object String]') {
                const parsedDate = Date.parse(dateValue);

                if (!parsedDate) {
                    return null;
                }

                return new Date(parsedDate);
            }

            return null;
        };

        this.evaluateBotOperation = async function(operation) {
            if (!operation) {
                return undefined;
            }

            if (!(operation.operand && operation.firstEntity && operation.secondEntity)) {
                return undefined;
            }

            let firstValue = await this.evaluateBotOperationEntity(operation.firstEntity);
            const secondValue = await this.evaluateBotOperationEntity(operation.secondEntity);

            if (firstValue === undefined || secondValue === undefined) {
                return undefined;
            }

            switch ((operation.operand || '').toLowerCase()) {
                case 'and': {
                    return Number(firstValue) & Number(secondValue);
                }

                case 'or': {
                    return Number(firstValue) | Number(secondValue);
                }

                case 'add': {
                    return Number(firstValue) + Number(secondValue);
                }

                case 'subtract': {
                    return Number(firstValue) - Number(secondValue);
                }

                case 'multiply': {
                    return Number(firstValue) * Number(secondValue);
                }

                case 'divide': {
                    return Number(firstValue) / Number(secondValue);
                }

                case 'adddays': {
                    if (!(firstValue = this.getDateObjectOrNull(firstValue))) {
                        return undefined;
                    }

                    firstValue.setDate(firstValue.getDate() + secondValue);

                    return firstValue;
                }

                case 'subtractdays': {
                    if (!(firstValue = this.getDateObjectOrNull(firstValue))) {
                        return undefined;
                    }

                    firstValue.setDate(firstValue.getDate() - secondValue);

                    return firstValue;
                }

                case 'addhours': {
                    if (!(firstValue = this.getDateObjectOrNull(firstValue))) {
                        return undefined;
                    }

                    firstValue.setTime(firstValue.getTime() + secondValue * 60 * 60 * 1000);

                    return firstValue;
                }

                case 'subtracthours': {
                    if (!(firstValue = this.getDateObjectOrNull(firstValue))) {
                        return undefined;
                    }

                    firstValue.setTime(firstValue.getTime() - secondValue * 60 * 60 * 1000);

                    return firstValue;
                }

                case 'addminutes': {
                    if (!(firstValue = this.getDateObjectOrNull(firstValue))) {
                        return undefined;
                    }

                    firstValue.setTime(firstValue.getTime() + secondValue * 60 * 1000);

                    return firstValue;
                }

                case 'subtractminutes': {
                    if (!(firstValue = this.getDateObjectOrNull(firstValue))) {
                        return undefined;
                    }

                    firstValue.setTime(firstValue.getTime() - secondValue * 60 * 1000);

                    return firstValue;
                }

                default: {
                    return undefined;
                }
            }
        };

        this.filterComparisonOfTwoValuesIsCorrect = async function(comparator, firstValue, secondValue) {
            switch (comparator) {
                case 'is':
                    return String(firstValue) === String(secondValue);
                case 'is_not':
                    return String(firstValue) !== String(secondValue);
                case 'greater_than':
                    return Number(firstValue) > Number(secondValue);
                case 'smaller_than':
                    return Number(firstValue) < Number(secondValue);
                case 'greater_or_equal':
                    return Number(firstValue) >= Number(secondValue);
                case 'smaller_or_equal':
                    return Number(firstValue) <= Number(secondValue);
                default:
                    return false;
            }
        };

        this.botFilterByAttributeConditionIsMet = async function(filter) {
            let attributeValue = this.getVar(filter.filterItem.name);

            if (!attributeValue) {
                attributeValue = await this.getVar(filter.filterItem.name, true);
            }

            const filterValue = filter.filterValue;
            const filterOperation = filter.filterOperation;

            return this.filterComparisonOfTwoValuesIsCorrect(filterOperation, attributeValue, filterValue);
        };

        this.evaluateCalculationEntity = async function(calculationEntity) {
            if (!(calculationEntity && calculationEntity.type)) {
                return undefined;
            }

            switch (calculationEntity.type.toLowerCase()) {
                case 'simplevalue': {
                    // returning async function
                    return this.evaluateBotOperationEntity(calculationEntity.valueEntity);
                }

                case 'operation': {
                    // returning async funtion
                    return this.evaluateBotOperation(calculationEntity.operation);
                }

                default:
                    return undefined;
            }
        };

        this.botFilterByCalculationConditionIsMet = async function(filter) {
            const firstCalculationValue = await this.evaluateCalculationEntity(filter.firstCalculation);
            const secondCalculationValue = await this.evaluateCalculationEntity(filter.secondCalculation);

            if (firstCalculationValue === undefined || secondCalculationValue === undefined) {
                return false;
            }

            return this.filterComparisonOfTwoValuesIsCorrect(
                filter.calculationComparator,
                firstCalculationValue,
                secondCalculationValue
            );
        };

        this.botFilterConditionIsMet = async function(filter) {
            if (!(filter && filter.filterBy)) {
                return false;
            }

            switch (filter.filterBy.toLowerCase()) {
                case 'attribute': {
                    // returning async function
                    return this.botFilterByAttributeConditionIsMet(filter);
                }

                case 'calculation': {
                    // returning async function
                    return this.botFilterByCalculationConditionIsMet(filter);
                }

                default:
                    return false;
            }
        };

        this.filtersAreCorrect = async function(filters, logicalOperator) {
            if (!(filters && filters.length)) {
                return true;
            }

            let isFiltersResultCorrect, resultShouldBeReversed;

            if ((logicalOperator || '').toLowerCase() === 'or') {
                isFiltersResultCorrect = false;

                // returning async function
                resultShouldBeReversed = (filter) => this.botFilterConditionIsMet(filter);
            } else {
                isFiltersResultCorrect = true;

                // returning async function
                resultShouldBeReversed = (filter) => this.botFilterConditionIsMet(filter).then((result) => !result);
            }

            for (let filter of filters) {
                if (await resultShouldBeReversed(filter)) {
                    return !isFiltersResultCorrect;
                }
            }

            return isFiltersResultCorrect;
        };

        this.getDirectToFlowConditionResult = async function(condition) {
            const { filters, allowRandom, logicalOperator, selectedItemGroups } = condition;

            const conditionIsTrue = await this.filtersAreCorrect(filters, logicalOperator);

            if (!conditionIsTrue) {
                return { success: false };
            }

            if (!allowRandom) {
                return { success: true, data: selectedItemGroups[0] };
            }

            const randomIndex = Math.floor(Math.random() * selectedItemGroups.length);

            return { success: true, data: selectedItemGroups[randomIndex] };
        };

        this.evaluateMultipleDirectToFlowConditions = async function(conditions = []) {
            for (let condition of conditions) {
                const result = await this.getDirectToFlowConditionResult(condition);

                if (result.success) {
                    return result.data;
                }
            }

            return null;
        };

        this.evaluateGotoDialogue = async function(gotoDialogue) {
            const { filters, allowRandom, logicalOperator, dialogueGroups, elseConditions } = gotoDialogue;

            const combinedConditions = [
                { filters, allowRandom, logicalOperator, selectedItemGroups: dialogueGroups },
                ...(elseConditions || [])
            ];

            const messageText = await this.evaluateMultipleDirectToFlowConditions(combinedConditions);

            if (!messageText) {
                return;
            }

            const message = this.cloneTriggerMessage(this.source_message);

            message.text = messageText;
            this.stop();
            this.task.botkit.trigger('custom_trigger', [this.task.bot, message]);

            return;
        };

        this.evaluateLinkToSubscription = async function(linkToSubscription, callScheduler) {
            const {
                filters,
                allowRandom,
                loopbackUrl,
                helperApiUrl,
                logicalOperator,
                subscriptionGroups,
                elseConditions
            } = linkToSubscription;

            if (!(loopbackUrl && helperApiUrl)) {
                console.error('No loopbackUrl or helperApiUrl specified in linkToSubscription so aborting');

                return;
            }

            const combinedConditions = [
                { filters, allowRandom, logicalOperator, selectedItemGroups: subscriptionGroups },
                ...(elseConditions || [])
            ];

            const subscriptionGroup = await this.evaluateMultipleDirectToFlowConditions(combinedConditions);

            if (!subscriptionGroup) {
                return;
            }

            if (typeof callScheduler !== 'function') {
                console.error('callScheduler is not a function');

                return;
            }

            callScheduler(subscriptionGroup);

            return;
        };

        this.tick = async function() {
            var now = new Date();

            if (this.isActive()) {
                if (this.processing) {
                    // do nothing. The bot is waiting for async process to complete.
                } else if (this.handler) {
                    // check timeout!
                    // how long since task started?
                    var duration = now.getTime() - this.task.startTime.getTime();
                    // how long since last active?
                    var lastActive = now.getTime() - this.lastActive.getTime();

                    if (
                        this.task.timeLimit && // has a timelimit
                        duration > this.task.timeLimit && // timelimit is up
                        lastActive > this.task.timeLimit // nobody has typed for 60 seconds at least
                    ) {
                        // if timeoutHandler is set then call it, otherwise follow the normal flow
                        // this will not break others code, after the update
                        if (this.timeOutHandler) {
                            this.timeOutHandler(this);
                        } else if (this.hasThread('on_timeout')) {
                            this.status = 'ending';
                            this.gotoThread('on_timeout');
                        } else {
                            this.stop('timeout');
                        }
                    }
                    // otherwise do nothing
                } else {
                    if (this.messages.length) {
                        if (this.sent.length && !this.sent[this.sent.length - 1].sent) {
                            return;
                        }

                        if (
                            this.task.bot.botkit.config.require_delivery &&
                            this.sent.length &&
                            !this.sent[this.sent.length - 1].delivered
                        ) {
                            return;
                        }

                        if (
                            typeof this.messages[0].timestamp == 'undefined' ||
                            this.messages[0].timestamp <= now.getTime()
                        ) {
                            var message = this.messages.shift();
                            this.lastMessage = message;

                            if (message.setVar) {
                                try {
                                    if (message.setVar.isUseOperation) {
                                        const operationResult = await this.evaluateBotOperation(
                                            message.setVar.operation
                                        );

                                        this.setVar(message.setVar.key, operationResult, message.setVar.isPersist);
                                    } else {
                                        if (message.setVar.valueEntity) {
                                            const evaluatedValue = await this.evaluateBotOperationEntity(
                                                message.setVar.valueEntity
                                            );

                                            this.setVar(message.setVar.key, evaluatedValue, message.setVar.isPersist);
                                        } else {
                                            this.setVar(
                                                message.setVar.key,
                                                message.setVar.value,
                                                message.setVar.isPersist
                                            );
                                        }
                                    }
                                } catch (error) {
                                    console.error('Error in message.setVar in CoreBot:', error);
                                }
                            }

                            if (message.jsonApi) {
                                this.processing = true;
                                var that = this;
                                let { attributeObjects, pluginMessages } = message.jsonApiData;

                                if (Array.isArray(attributeObjects)) {
                                    attributeObjects = await Promise.all(
                                        attributeObjects.map(async (attributeObject) => {
                                            let value = this.getVar(attributeObject.name);

                                            if (!value) {
                                                value = await this.getVar(attributeObject.name, true);
                                            }

                                            return { ...attributeObject, value };
                                        })
                                    );
                                }

                                message.jsonApi(attributeObjects).then(
                                    function(data) {
                                        if (!data) {
                                            return;
                                        }

                                        that.processing = false;
                                        let hasAttachment = false;

                                        (async function(data) {
                                            const varsToSet = data.varsToSet || (data.data && data.data.varsToSet);

                                            if (!Array.isArray(varsToSet)) {
                                                return;
                                            }

                                            for (let varToSet of varsToSet) {
                                                if (varToSet.key) {
                                                    // make every varsToSet item persistent in database
                                                    await that.setVar(varToSet.key, varToSet.value, true);
                                                }
                                            }

                                            return;
                                        })(data);

                                        const apiMessages = data.messages || [];

                                        for (let i = apiMessages.length; i-- > 0; ) {
                                            let apiMessage = apiMessages[i];
                                            let outbound = that.cloneMessage(message);
                                            delete outbound.jsonApi;
                                            delete outbound.jsonApiData;

                                            if (apiMessage.attachment) {
                                                outbound.attachment = apiMessage.attachment;
                                                hasAttachment = true;
                                            } else {
                                                outbound.text = apiMessage.text || '';
                                                outbound.sent_timestamp = new Date().getTime();
                                            }

                                            if (i !== apiMessages.length - 1) {
                                                delete outbound.dialogueId;
                                                delete outbound.dialogueName;
                                            }

                                            that.addMessage(outbound, null, 1);
                                        }

                                        if (!(data.messages || data.varsToSet || (data.data && data.data.varToSet))) {
                                            // loop through data key and setVar for each key
                                            (async function(data) {
                                                for (let key of Object.keys(data)) {
                                                    // make every varsToSet item persistent in database
                                                    await that.setVar(`api_${key}`, data[key], true);
                                                }
                                            })(data);
                                        }

                                        // that.sent.push(outbound);
                                        // that.transcript.push(outbound);

                                        // that.task.bot.reply(that.source_message, outbound, function(err, sent_message) {
                                        //     if (err) {
                                        //         botkit.log('An error occurred while sending a message: ', err);

                                        //         // even though an error occured, set sent to true
                                        //         // this will allow the conversation to keep going even if one message fails
                                        //         // TODO: make a message that fails to send _resend_ at least once
                                        //         that.sent[that.sent.length - 1].sent = true;
                                        //         that.sent[that.sent.length - 1].api_response = err;

                                        //     } else {

                                        //         that.sent[that.sent.length - 1].sent = true;
                                        //         that.sent[that.sent.length - 1].api_response = sent_message;

                                        //         // if sending via slack's web api, there is no further confirmation
                                        //         // so we can mark the message delivered
                                        //         if (that.task.bot.type == 'slack' && sent_message && sent_message.ts) {
                                        //             that.sent[that.sent.length - 1].delivered = true;
                                        //         }

                                        //         that.trigger('sent', [sent_message]);

                                        //     }
                                        // });
                                    },
                                    function(err) {
                                        let outbound = that.cloneMessage(message);
                                        delete outbound.jsonApi;

                                        that.processing = false;
                                        console.error('err in jsonApi request', err);

                                        outbound.text =
                                            err.pluginMessage ||
                                            pluginMessages.errorOccured ||
                                            'An error occured with a request.';

                                        outbound.sent_timestamp = new Date().getTime();

                                        that.sent.push(outbound);
                                        that.transcript.push(outbound);

                                        that.task.bot.reply(that.source_message, outbound, function(err, sent_message) {
                                            if (err) {
                                                botkit.log('An error occurred while sending a message: ', err);

                                                // even though an error occured, set sent to true
                                                // this will allow the conversation to keep going even if one message fails
                                                // TODO: make a message that fails to send _resend_ at least once
                                                that.sent[that.sent.length - 1].sent = true;
                                                that.sent[that.sent.length - 1].api_response = err;
                                            } else {
                                                that.sent[that.sent.length - 1].sent = true;
                                                that.sent[that.sent.length - 1].api_response = sent_message;

                                                // if sending via slack's web api, there is no further confirmation
                                                // so we can mark the message delivered
                                                if (that.task.bot.type == 'slack' && sent_message && sent_message.ts) {
                                                    that.sent[that.sent.length - 1].delivered = true;
                                                }

                                                that.trigger('sent', [sent_message]);
                                            }
                                        });
                                    }
                                );
                            }

                            if (message.gotoDialogue) {
                                await this.evaluateGotoDialogue(message.gotoDialogue);
                            }

                            if (message.contactHuman) {
                                const messageCopy = this.cloneTriggerMessage(this.source_message);

                                messageCopy.dialogueId = message.dialogueId;
                                messageCopy.dialogueName = message.dialogueName;
                                messageCopy.replyText = message.contactHuman.message;
                                messageCopy.waitingMinutes = message.contactHuman.waitingMinutes;
                                messageCopy.noResponseMessage = message.contactHuman.noResponseMessage;
                                messageCopy.regainControlMessage = message.contactHuman.regainControlMessage;

                                this.task.botkit.trigger('human_handoff', [this.task.bot, messageCopy]);
                            }

                            if (message.linkToSubscription) {
                                // linkToSubscription doesn't need to pause messages that follow so no await here
                                this.evaluateLinkToSubscription(message.linkToSubscription, message.callScheduler);
                            }

                            if (message.backToBot) {
                                const messageCopy = this.cloneTriggerMessage(this.source_message);

                                messageCopy.dialogueId = message.dialogueId;
                                messageCopy.dialogueName = message.dialogueName;
                                messageCopy.isShowMessage = message.backToBot.isShowMessage;
                                messageCopy.messageToUser = message.backToBot.messageToUser;

                                this.task.botkit.trigger('back_to_bot', [this.task.bot, messageCopy]);
                            }

                            // make sure next message is delayed appropriately
                            if (this.messages.length && this.messages[0].delay) {
                                this.messages[0].timestamp = now.getTime() + this.messages[0].delay;
                            }

                            if (message.conditional) {
                                this.evaluateCondition(message.conditional);
                                // we want to stop processing this message
                                // because evaluate conditional can process a bunch of stuff
                                // and then move on to the next step internally
                                return;
                            } else {
                                if (message.handler) {
                                    this.handler = message.handler;
                                } else {
                                    this.handler = null;
                                }
                                if (message.capture_options) {
                                    this.capture_options = message.capture_options;
                                } else {
                                    this.capture_options = {};
                                }

                                this.lastActive = new Date();

                                // is there any text?
                                // or an attachment? (facebook)
                                // or multiple attachments (slack)
                                if (message.text || message.attachments || message.attachment) {
                                    var outbound = this.cloneMessage(message);
                                    var that = this;

                                    outbound.sent_timestamp = new Date().getTime();

                                    that.sent.push(outbound);
                                    that.transcript.push(outbound);

                                    this.task.bot.reply(this.source_message, outbound, function(err, sent_message) {
                                        if (err) {
                                            botkit.log('An error occurred while sending a message: ', err);

                                            // even though an error occured, set sent to true
                                            // this will allow the conversation to keep going even if one message fails
                                            // TODO: make a message that fails to send _resend_ at least once
                                            that.sent[that.sent.length - 1].sent = true;
                                            that.sent[that.sent.length - 1].api_response = err;
                                        } else {
                                            that.sent[that.sent.length - 1].sent = true;
                                            that.sent[that.sent.length - 1].api_response = sent_message;

                                            // if sending via slack's web api, there is no further confirmation
                                            // so we can mark the message delivered
                                            if (that.task.bot.type == 'slack' && sent_message && sent_message.ts) {
                                                that.sent[that.sent.length - 1].delivered = true;
                                            }

                                            that.trigger('sent', [sent_message]);
                                        }
                                    });
                                }
                                if (message.action) {
                                    this.handleAction(message);
                                }
                            } // if not conditional
                        } else {
                            // do nothing
                        }

                        // end immediately instad of waiting til next tick.
                        // if it hasn't already been ended by a message action!
                        if (this.isActive() && !this.messages.length && !this.handler && !this.processing) {
                            this.stop('completed');
                        }
                    } else if (this.sent.length) {
                        // sent at least 1 message
                        this.stop('completed');
                    }
                }
            }
        };

        botkit.debug('CREATED A CONVO FOR', this.source_message.user, this.source_message.channel);
        this.gotoThread('default');
    }

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    function Task(bot, message, botkit) {
        this.convos = [];
        this.botkit = botkit;
        this.bot = bot;

        this.events = {};
        this.source_message = message;
        this.status = 'active';
        this.startTime = new Date();

        this.isActive = function() {
            return this.status == 'active';
        };

        this.createConversation = function(message) {
            var convo = new Conversation(this, message);
            convo.id = botkit.convoCount++;
            this.convos.push(convo);

            return convo;
        };

        this.startConversation = function(message) {
            var convo = this.createConversation(message);
            botkit.debug('>   [Start] ', convo.id, ' Conversation with ', message.user, 'in', message.channel);

            convo.activate();
            return convo;
        };

        this.conversationEnded = function(convo) {
            var that = this;
            botkit.middleware.conversationEnd.run(this.bot, convo, function(err, bot, convo) {
                botkit.debug(
                    '>   [End] ',
                    convo.id,
                    ' Conversation with ',
                    convo.source_message.user,
                    'in',
                    convo.source_message.channel
                );
                that.trigger('conversationEnded', [convo]);
                that.botkit.trigger('conversationEnded', [bot, convo]);
                convo.trigger('end', [convo]);
                var actives = 0;
                for (var c = 0; c < that.convos.length; c++) {
                    if (that.convos[c].isActive()) {
                        actives++;
                    }
                }
                if (actives == 0) {
                    that.taskEnded();
                }
            });
        };

        this.endImmediately = function(reason) {
            for (var c = 0; c < this.convos.length; c++) {
                if (this.convos[c].isActive()) {
                    this.convos[c].stop(reason || 'stopped');
                }
            }
        };

        this.taskEnded = function() {
            botkit.debug('[End] ', this.id, ' Task for ', this.source_message.user, 'in', this.source_message.channel);

            this.status = 'completed';
            this.trigger('end', [this]);
        };

        this.on = function(event, cb) {
            botkit.debug('Setting up a handler for', event);
            var events = event.split(/\,/g);
            for (var e in events) {
                if (!this.events[events[e]]) {
                    this.events[events[e]] = [];
                }
                this.events[events[e]].push(cb);
            }
            return this;
        };

        this.trigger = function(event, data) {
            if (this.events[event]) {
                for (var e = 0; e < this.events[event].length; e++) {
                    var res = this.events[event][e].apply(this, data);
                    if (res === false) {
                        return;
                    }
                }
            }
        };

        this.getResponsesByUser = function() {
            var users = {};

            // go through all conversations
            // extract normalized answers
            for (var c = 0; c < this.convos.length; c++) {
                var user = this.convos[c].source_message.user;
                users[this.convos[c].source_message.user] = {};
                var convo = this.convos[c];
                users[user] = convo.extractResponses();
            }

            return users;
        };

        this.getResponsesBySubject = function() {
            var answers = {};

            // go through all conversations
            // extract normalized answers
            for (var c = 0; c < this.convos.length; c++) {
                var convo = this.convos[c];

                for (var key in convo.responses) {
                    if (!answers[key]) {
                        answers[key] = {};
                    }
                    answers[key][convo.source_message.user] = convo.extractResponse(key);
                }
            }

            return answers;
        };

        this.tick = function() {
            for (var c = 0; c < this.convos.length; c++) {
                if (this.convos[c].isActive()) {
                    this.convos[c].tick();
                }
            }
        };
    }

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    botkit.storage = {
        teams: {
            get: function(team_id, cb) {
                cb(null, botkit.memory_store.teams[team_id]);
            },
            save: function(team, cb) {
                if (team.id) {
                    botkit.memory_store.teams[team.id] = team;
                    cb(null, team.id);
                } else {
                    cb('No ID specified');
                }
            },
            delete: function(team_id, cb) {
                delete botkit.memory_store.teams[team_id];
                cb();
            },
            all: function(cb) {
                cb(null, botkit.memory_store.teams);
            }
        },
        users: {
            get: function(user_id, cb) {
                cb(null, botkit.memory_store.users[user_id]);
            },
            save: function(user, cb) {
                if (user.id) {
                    botkit.memory_store.users[user.id] = user;
                    cb(null, user.id);
                } else {
                    cb('No ID specified');
                }
            },
            delete: function(user_id, cb) {
                delete botkit.memory_store.users[user_id];
                cb();
            },
            all: function(cb) {
                cb(null, botkit.memory_store.users);
            }
        },
        channels: {
            get: function(channel_id, cb) {
                cb(null, botkit.memory_store.channels[channel_id]);
            },
            save: function(channel, cb) {
                if (channel.id) {
                    botkit.memory_store.channels[channel.id] = channel;
                    cb(null, channel.id);
                } else {
                    cb('No ID specified');
                }
            },
            delete: function(user_id, cb) {
                delete botkit.memory_store.channels[channel_id];
                cb();
            },
            all: function(cb) {
                cb(null, botkit.memory_store.channels);
            }
        }
    };

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    /**
     * hears_regexp - default string matcher uses regular expressions
     *
     * @param  {array}  tests    patterns to match
     * @param  {object} message message object with various fields
     * @return {boolean}        whether or not a pattern was matched
     */
    botkit.hears_regexp = function(tests, message) {
        for (var t = 0; t < tests.length; t++) {
            if (message.text) {
                // the pattern might be a string to match (including regular expression syntax)
                // or it might be a prebuilt regular expression
                var test = null;
                if (typeof tests[t] == 'string') {
                    try {
                        test = new RegExp(tests[t], 'i');
                    } catch (err) {
                        botkit.log('Error in regular expression: ' + tests[t] + ': ' + err);
                        return false;
                    }
                    if (!test) {
                        return false;
                    }
                } else {
                    test = tests[t];
                }

                if ((match = message.text.match(test))) {
                    message.match = match;
                    return true;
                }
            }
        }
        return false;
    };

    /**
     * changeEars - change the default matching function
     *
     * @param  {function} new_test a function that accepts (tests, message) and returns a boolean
     */
    botkit.changeEars = function(new_test) {
        botkit.hears_test = new_test;
    };

    botkit.hears = function(keywords, events, middleware_or_cb, cb) {
        // the third parameter is EITHER a callback handler
        // or a middleware function that redefines how the hear works
        var test_function = botkit.hears_test;
        if (cb) {
            test_function = middleware_or_cb;
        } else {
            cb = middleware_or_cb;
        }

        if (typeof keywords == 'string') {
            keywords = [keywords];
        }

        if (keywords instanceof RegExp) {
            keywords = [keywords];
        }

        if (typeof events == 'string') {
            events = events.split(/\,/g).map(function(str) {
                return str.trim();
            });
        }

        for (var e = 0; e < events.length; e++) {
            (function(keywords, test_function) {
                botkit.on(
                    events[e],
                    function(bot, message) {
                        if (test_function && test_function(keywords, message)) {
                            botkit.debug('I HEARD', keywords);
                            botkit.middleware.heard.run(bot, message, function(err, bot, message) {
                                cb.apply(this, [bot, message]);
                                botkit.trigger('heard_trigger', [bot, keywords, message]);
                            });
                            return false;
                        }
                    },
                    true
                );
            })(keywords, test_function);
        }

        return this;
    };

    botkit.on = function(event, cb, is_hearing) {
        botkit.debug('Setting up a handler for', event);
        var events = typeof event == 'string' ? event.split(/\,/g) : event;

        for (var e in events) {
            if (!this.events[events[e]]) {
                this.events[events[e]] = [];
            }
            this.events[events[e]].push({
                callback: cb,
                type: is_hearing ? 'hearing' : 'event'
            });
        }
        return this;
    };

    botkit.trigger = function(event, data) {
        if (this.events[event]) {
            var hearing = this.events[event].filter(function(e) {
                return e.type == 'hearing';
            });

            var handlers = this.events[event].filter(function(e) {
                return e.type != 'hearing';
            });

            // first, look for hearing type events
            // these are always handled before normal event handlers
            for (var e = 0; e < hearing.length; e++) {
                var res = hearing[e].callback.apply(this, data);
                if (res === false) {
                    return;
                }
            }

            // now, if we haven't already heard something,
            // fire the remaining event handlers
            if (handlers.length) {
                botkit.middleware.triggered.run(data[0], data[1], function(err, bot, message) {
                    for (var e = 0; e < handlers.length; e++) {
                        var res = handlers[e].callback.apply(this, data);
                        if (res === false) {
                            return;
                        }
                    }
                });
            }
        }
    };

    botkit.startConversation = function(bot, message, cb) {
        botkit.startTask(bot, message, function(task, convo) {
            cb(null, convo);
        });
    };

    botkit.createConversation = function(bot, message, cb) {
        var task = new Task(bot, message, this);

        task.id = botkit.taskCount++;

        var convo = task.createConversation(message);

        this.tasks.push(task);

        cb(null, convo);
    };

    botkit.defineBot = function(unit) {
        if (typeof unit != 'function') {
            throw new Error('Bot definition must be a constructor function');
        }
        this.worker = unit;
    };

    botkit.spawn = function(config, cb) {
        var worker = new this.worker(this, config);
        // mutate the worker so that we can call middleware
        worker.say = function(message, cb) {
            var platform_message = {};
            botkit.middleware.send.run(worker, message, function(err, worker, message) {
                if (err) {
                    botkit.log('An error occured in the send middleware:: ' + err);
                    if (cb) {
                        cb(err);
                    }
                } else {
                    botkit.middleware.format.run(worker, message, platform_message, function(
                        err,
                        worker,
                        message,
                        platform_message
                    ) {
                        if (err) {
                            botkit.log('An error occured in the format middleware: ' + err);
                            if (cb) {
                                cb(err);
                            }
                        } else {
                            worker.send(platform_message, cb);
                        }
                    });
                }
            });
        };

        // add platform independent convenience methods
        worker.startConversation = function(message, cb) {
            botkit.startConversation(worker, message, cb);
        };

        worker.createConversation = function(message, cb) {
            botkit.createConversation(worker, message, cb);
        };

        botkit.middleware.spawn.run(worker, function(err, worker) {
            if (err) {
                botkit.log('Error in middleware.spawn.run: ' + err);
            } else {
                botkit.trigger('spawned', [worker]);

                if (cb) {
                    cb(worker);
                }
            }
        });

        return worker;
    };

    // change the speed of sending messages in a conversation
    // defaults to 1500
    botkit.setTickDelay = function(delay) {
        botkit.tickDelay = delay;
    };

    botkit.startTicking = function() {
        if (!botkit.tickInterval) {
            // set up a once a second tick to process messages
            botkit.tickInterval = setInterval(function() {
                botkit.tick();
            }, botkit.tickDelay);
        }
    };

    botkit.shutdown = function() {
        if (botkit.tickInterval) {
            clearInterval(botkit.tickInterval);
        }
    };

    botkit.startTask = function(bot, message, cb) {
        var task = new Task(bot, message, this);

        task.id = botkit.taskCount++;
        botkit.debug('[Start] ', task.id, ' Task for ', message.user, 'in', message.channel);

        var convo = task.startConversation(message);

        this.tasks.push(task);

        if (cb) {
            cb(task, convo);
        } else {
            return task;
        }
    };

    botkit.tick = function() {
        for (var t = 0; t < botkit.tasks.length; t++) {
            botkit.tasks[t].tick();
        }
        for (var t = botkit.tasks.length - 1; t >= 0; t--) {
            if (!botkit.tasks[t].isActive()) {
                botkit.tasks.splice(t, 1);
            }
        }

        this.trigger('tick', []);
    };

    // Provide a fairly simple Express-based webserver
    botkit.setupWebserver = function(port, cb) {
        if (!port) {
            throw new Error('Cannot start webserver without a port');
        }

        var static_dir = process.cwd() + '/public';

        if (botkit.config && botkit.config.webserver && botkit.config.webserver.static_dir)
            static_dir = botkit.config.webserver.static_dir;

        botkit.config.port = port;

        botkit.webserver = express();
        botkit.webserver.use(bodyParser.json());
        botkit.webserver.use(
            bodyParser.urlencoded({
                extended: true
            })
        );
        botkit.webserver.use(express.static(static_dir));

        var server = botkit.webserver.listen(botkit.config.port, botkit.config.hostname, function() {
            botkit.log('** Starting webserver on port ' + botkit.config.port);
            if (cb) {
                cb(null, botkit.webserver);
            }
            botkit.trigger('webserver_up', [botkit.webserver]);
        });

        return botkit;
    };

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    /**
     * Define a default worker bot. This function should be customized outside
     * of Botkit and passed in as a parameter by the developer
     **/
    botkit.worker = function(botkit, config) {
        this.botkit = botkit;
        this.config = config;

        this.say = function(message, cb) {
            botkit.debug('SAY:', message);
            if (cb) {
                cb();
            }
        };

        this.replyWithQuestion = function(message, question, cb) {
            botkit.startConversation(message, function(convo) {
                convo.ask(question, cb);
            });
        };

        this.reply = function(src, resp) {
            botkit.debug('REPLY:', resp);
        };

        this.findConversation = function(message, cb) {
            botkit.debug('DEFAULT FIND CONVO');
            cb(null);
        };
    };

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

    botkit.userAgent = function() {
        if (!botkit.my_user_agent) {
            // set user agent to Botkit
            var ua = 'Botkit/' + botkit.version();

            // add OS info
            ua = ua + ' ' + os.platform() + '/' + os.release();

            // add Node info
            ua = ua + ' ' + 'node/' + process.version.replace('v', '');

            botkit.my_user_agent = ua;
        }

        return botkit.my_user_agent;
    };

    botkit.version = function() {
        if (!botkit.my_version) {
            botkit.my_version = PKG_VERSION;
        }
        return botkit.my_version;
    };

    botkit.config = configuration;

    /** Default the application to listen to the 0.0.0.0, the default
     * for node's http module. Developers can specify a hostname or IP
     * address to override this.
     **/
    if (!botkit.config.hostname) {
        botkit.config.hostname = '0.0.0.0';
    }

    if (!configuration.logLevel) {
        if (configuration.debug) {
            configuration.logLevel = 'debug';
        } else if (configuration.log === false) {
            configuration.logLevel = 'error';
        } else {
            configuration.logLevel = 'info';
        }
    }

    if (configuration.logger) {
        if (typeof configuration.logger.log === 'function') {
            botkit.logger = configuration.logger;
        } else {
            throw new Error('Logger object does not have a `log` method!');
        }
    } else {
        botkit.logger = ConsoleLogger(console, configuration.logLevel);
    }

    botkit.log = function() {
        botkit.log.info.apply(botkit.log, arguments);
    };
    Object.keys(LogLevels).forEach(function(level) {
        botkit.log[level] = botkit.logger.log.bind(botkit.logger, level);
    });
    botkit.debug = botkit.log.debug;

    if (!botkit.config.disable_startup_messages) {
        console.log('Initializing Botkit v' + botkit.version());
    }

    if (configuration.storage) {
        if (
            configuration.storage.teams &&
            configuration.storage.teams.get &&
            configuration.storage.teams.save &&
            configuration.storage.users &&
            configuration.storage.users.get &&
            configuration.storage.users.save &&
            configuration.storage.channels &&
            configuration.storage.channels.get &&
            configuration.storage.channels.save
        ) {
            botkit.log('** Using custom storage system.');
            botkit.storage = configuration.storage;
        } else {
            throw new Error('Storage object does not have all required methods!');
        }
    } else if (configuration.json_file_store) {
        botkit.log('** Using simple storage. Saving data to ' + configuration.json_file_store);
        botkit.storage = simple_storage({
            path: configuration.json_file_store
        });
    } else {
        botkit.log('** No persistent storage method specified! Data may be lost when process shuts down.');
    }

    // set the default set of ears to use the regular expression matching
    botkit.changeEars(botkit.hears_regexp);

    //enable Botkit Studio
    studio(botkit);

    return botkit;
}

module.exports = Botkit;
