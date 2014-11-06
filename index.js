var http = require('http');
var util = require('util');
var crypto = require('crypto');

exports.createServer = function(requestListener) {
  return new Server(requestListener);
};

exports.Server = Server;

util.inherits(Server, http.Server);

function Server(requestListener) {
  if (!(this instanceof Server)) {
    return new Server(requestListener);
  }

  http.Server.call(this);

  var self = this;

  this.on('upgrade', function(req, socket, head) {
    console.log('upgrade!', req.headers, head.length);

    if (!req.headers.upgrade || 'websocket' !== req.headers.upgrade.toLowerCase()) {
      self.abortConnection(socket);
      return;
    }

    var key = req.headers['sec-websocket-key'];
    if (!key) {
      self.abortConnection(socket);
      return;
    }

    var version = parseInt(req.headers['sec-websocket-version'], 10);
    if (13 !== version) {
      self.abortConnection(socket);
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
  });
}

Server.prototype.abortConnection = function(socket) {
  socket.write([
    'HTTP/1.1 400 Bad Request',
    'Content-type: text/html'
  ].join('\r\n') + '\r\n\r\n');
  socket.destroy();
};
