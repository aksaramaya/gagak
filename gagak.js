(function() {
  var Event, EventPublisher, Netmask, Payload, PushServices, Subscriber, app, authorize, bodyParser, checkStatus, checkUserAndPassword, conf, createSubscriber, dgram, eventPublisher, eventSourceEnabled, event_route, express, getEventFromId, i, len, listen_ip, logger, loggerconfig, name, port, pushServices, redis, ref, ref1, ref2, ref3, ref4, ref5, ref6, ref7, ref8, settings, testSubscriber, tokenResolver, transport, udpApi, url, zlib,
    indexOf = [].indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; };

  express = require('express');
  bodyParser = require('body-parser');
  dgram = require('dgram');
  zlib = require('zlib');
  url = require('url');
  Netmask = require('netmask').Netmask;
  settings = require('./settings');
  Subscriber = require('./lib/subscriber').Subscriber;
  EventPublisher = require('./lib/eventpublisher').EventPublisher;
  Event = require('./lib/event').Event;
  PushServices = require('./lib/pushservices').PushServices;
  Payload = require('./lib/payload').Payload;
  logger = require('winston');

  if (settings.server.redis_socket != null) {
    redis = require('redis').createClient(settings.server.redis_socket);
  } else if ((settings.server.redis_port != null) || (settings.server.redis_host != null)) {
    redis = require('redis').createClient(settings.server.redis_port, settings.server.redis_host);
  } else {
    redis = require('redis').createClient();
  }

  if (settings.server.redis_db_number != null) {
    redis.select(settings.server.redis_db_number);
  }

  if (settings.logging != null) {
    logger.remove(logger.transports.Console);
    ref = settings.logging;
    for (i = 0, len = ref.length; i < len; i++) {
      loggerconfig = ref[i];
      transport = logger.transports[loggerconfig['transport']];
      if (transport != null) {
        logger.add(transport, loggerconfig.options || {});
      } else {
        process.stderr.write("Invalid logger transport: " + loggerconfig['transport'] + "\n");
      }
    }
  }

  if (((ref1 = settings.server) != null ? ref1.redis_auth : void 0) != null) {
    redis.auth(settings.server.redis_auth);
  }

  createSubscriber = function(fields, cb) {
    var service;
    logger.verbose("creating subscriber proto = " + fields.proto + ", token = " + fields.token);
    if (!(service = pushServices.getService(fields.proto))) {
      throw new Error("Invalid value for `proto'");
    }
    if (!(fields.token = service.validateToken(fields.token))) {
      throw new Error("Invalid value for `token'");
    }
    return Subscriber.prototype.create(redis, fields, cb);
  };

  tokenResolver = function(proto, token, cb) {
    return Subscriber.prototype.getInstanceFromToken(redis, proto, token, cb);
  };

  eventSourceEnabled = false;

  pushServices = new PushServices();

  for (name in settings) {
    conf = settings[name];
    if (!conf.enabled) {
      continue;
    }
    logger.info("Registering push service: " + name);
    if (name === 'event-source') {
      eventSourceEnabled = true;
    } else {
      pushServices.addService(name, new conf["class"](conf, logger, tokenResolver));
    }
  }

  eventPublisher = new EventPublisher(pushServices);

  checkUserAndPassword = (function(_this) {
    return function(username, password) {
      var passwordOK, ref2;
      if (((ref2 = settings.server) != null ? ref2.auth : void 0) != null) {
        if (settings.server.auth[username] == null) {
          logger.error("Unknown user " + username);
          return false;
        }
        passwordOK = (password != null) && password === settings.server.auth[username].password;
        if (!passwordOK) {
          logger.error("Invalid password for " + username);
        }
        return passwordOK;
      }
      return false;
    };
  })(this);

  app = express();

  if ((ref2 = settings.server) != null ? ref2.access_log : void 0) {
    app.use(express.logger(':method :url :status'));
  }

  if ((((ref3 = settings.server) != null ? ref3.auth : void 0) != null) && (((ref4 = settings.server) != null ? ref4.acl : void 0) == null)) {
    app.use(express.basicAuth(checkUserAndPassword));
  }

  app.use(bodyParser.urlencoded({
    limit: '1mb',
    extended: true
  }));

  app.use(bodyParser.json({
    limit: '1mb'
  }));

  app.use(app.router);

  app.disable('x-powered-by');

  app.param('subscriber_id', function(req, res, next, id) {
    var error;
    try {
      req.subscriber = new Subscriber(redis, req.params.subscriber_id);
      delete req.params.subscriber_id;
      return next();
    } catch (error1) {
      error = error1;
      return res.json({
        error: error.message
      }, 400);
    }
  });

  getEventFromId = function(id) {
    return new Event(redis, id);
  };

  testSubscriber = function(subscriber) {
    return pushServices.push(subscriber, null, new Payload({
      msg: "Test",
      "data.test": "ok"
    }));
  };

  checkStatus = function() {
    return redis.connected;
  };

  app.param('event_id', function(req, res, next, id) {
    var error;
    try {
      req.event = getEventFromId(req.params.event_id);
      delete req.params.event_id;
      return next();
    } catch (error1) {
      error = error1;
      return res.json({
        error: error.message
      }, 400);
    }
  });

  authorize = function(realm) {
    var allow_from, j, len1, network, networks, ref5, ref6, ref7;
    if (((ref5 = settings.server) != null ? ref5.auth : void 0) != null) {
      return function(req, res, next) {
        var allowedRealms, ref6;
        logger.verbose("Authenticating " + req.user + " for " + realm);
        if (req.user == null) {
          logger.error("User not authenticated");
          res.json({
            error: 'Unauthorized'
          }, 403);
          return;
        }
        allowedRealms = ((ref6 = settings.server.auth[req.user]) != null ? ref6.realms : void 0) || [];
        if (indexOf.call(allowedRealms, realm) < 0) {
          logger.error("No access to " + realm + " for " + req.user + ", allowed: " + allowedRealms);
          res.json({
            error: 'Unauthorized'
          }, 403);
          return;
        }
        return next();
      };
    } else if (allow_from = (ref6 = settings.server) != null ? (ref7 = ref6.acl) != null ? ref7[realm] : void 0 : void 0) {
      networks = [];
      for (j = 0, len1 = allow_from.length; j < len1; j++) {
        network = allow_from[j];
        networks.push(new Netmask(network));
      }
      return function(req, res, next) {
        var k, len2, remoteAddr;
        if (remoteAddr = req.socket && (req.socket.remoteAddress || (req.socket.socket && req.socket.socket.remoteAddress))) {
          for (k = 0, len2 = networks.length; k < len2; k++) {
            network = networks[k];
            if (network.contains(remoteAddr)) {
              next();
              return;
            }
          }
        }
        return res.json({
          error: 'Unauthorized'
        }, 403);
      };
    } else {
      return function(req, res, next) {
        return next();
      };
    }
  };

  require('./lib/api').setupRestApi(app, createSubscriber, getEventFromId, authorize, testSubscriber, eventPublisher, checkStatus);

  if (eventSourceEnabled) {
    require('./lib/eventsource').setup(app, authorize, eventPublisher);
  }

  port = (ref5 = settings != null ? (ref6 = settings.server) != null ? ref6.tcp_port : void 0 : void 0) != null ? ref5 : 80;

  listen_ip = settings != null ? (ref7 = settings.server) != null ? ref7.listen_ip : void 0 : void 0;

  if (listen_ip) {
    app.listen(port, listen_ip);
    logger.info("Listening on ip address " + listen_ip + " and tcp port " + port);
  } else {
    app.listen(port);
    logger.info("Listening on tcp port " + port);
  }

  udpApi = dgram.createSocket("udp4");

  event_route = /^\/event\/([a-zA-Z0-9:._-]{1,100})$/;

  udpApi.checkaccess = authorize('publish');

  udpApi.on('message', function(msg, rinfo) {
    return zlib.unzip(msg, (function(_this) {
      return function(err, msg) {
        var method, ref8, ref9, req;
        if (err || !msg.toString()) {
          logger.error("UDP Cannot decode message: " + err);
          return;
        }
        ref8 = msg.toString().split(/\s+/, 2), method = ref8[0], msg = ref8[1];
        if (!msg) {
          ref9 = [method, 'POST'], msg = ref9[0], method = ref9[1];
        }
        req = url.parse(msg != null ? msg : '', true);
        method = method.toUpperCase();
        return _this.checkaccess({
          socket: {
            remoteAddress: rinfo.address
          }
        }, {
          json: function() {
            return logger.info("UDP/" + method + " " + req.pathname + " 403");
          }
        }, function() {
          var error, event, m, ref10, ref11, status;
          status = 404;
          if (m = (ref10 = req.pathname) != null ? ref10.match(event_route) : void 0) {
            try {
              event = new Event(redis, m[1]);
              status = 204;
              switch (method) {
                case 'POST':
                  eventPublisher.publish(event, req.query);
                  break;
                case 'DELETE':
                  event["delete"]();
                  break;
                default:
                  status = 404;
              }
            } catch (error1) {
              error = error1;
              logger.error(error.stack);
              return;
            }
          }
          if ((ref11 = settings.server) != null ? ref11.access_log : void 0) {
            return logger.info("UDP/" + method + " " + req.pathname + " " + status);
          }
        });
      };
    })(this));
  });

  port = settings != null ? (ref8 = settings.server) != null ? ref8.udp_port : void 0 : void 0;

  if (port != null) {
    udpApi.bind(port);
    logger.info("Listening on udp port " + port);
  }

}).call(this);
