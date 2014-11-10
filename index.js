var http = require('http');
var crypto = require('crypto');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Socket = require('./lib/socket');

exports.createServer = function(connectionListener) {
  return new Server(connectionListener);
};

exports.Server = Server;

util.inherits(Server, EventEmitter);

function Server(connectionListener) {
  if (!(this instanceof Server)) {
    return new Server(connectionListener);
  }

  EventEmitter.call(this);

  if (connectionListener) {
    this.on('connection', connectionListener);
  }

  var self = this;

  this._http = http.createServer();
  this._http.on('upgrade', function(req, socket, head) {
    var conn = new Socket(req, socket, head);
    conn.upgrade(function(err, socket) {
      self.emit('connection', socket);
    });
  });
}

Server.prototype.listen = function() {
  this._http.listen.apply(this._http, arguments);
};

