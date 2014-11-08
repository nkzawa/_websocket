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
    if (!req.headers.upgrade || 'websocket' !== req.headers.upgrade.toLowerCase()) {
      abortConnection(socket);
      return;
    }

    var key = req.headers['sec-websocket-key'];
    if (!key) {
      abortConnection(socket);
      return;
    }

    var version = parseInt(req.headers['sec-websocket-version'], 10);
    if (13 !== version) {
      abortConnection(socket);
      return;
    }

    key = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + key
    ].join('\r\n') + '\r\n\r\n');

    self.emit('connection', new Socket(req, socket));
  });
}

Server.prototype.listen = function() {
  this._http.listen.apply(this._http, arguments);
};

function abortConnection(socket) {
  socket.write([
    'HTTP/1.1 400 Bad Request',
    'Content-type: text/html',
    'Sec-WebSocket-Version: 13'
  ].join('\r\n') + '\r\n\r\n');
  socket.destroy();
}
