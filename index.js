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

    var version = parseInt(req.headers['sec-websocket-version'], 10);
    if (13 !== version) {
      abortConnection(socket);
      return;
    }

    var key = req.headers['sec-websocket-key'];
    if (!key) {
      abortConnection(socket);
      return;
    }

    var acceptKey = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    var extensions = parseExtensions(req);

    var _extensions = {};
    if (extensions['permessage-deflate']) {
      _extensions['permessage-deflate'] = true;
    } else if (extensions['x-webkit-deflate-frame']) {
      _extensions['x-webkit-deflate-frame'] = true;
    }

    // TODO:
    //   client_max_window_bits
    //   server_max_window_bits
    //   client_no_context_takeover
    //   server_no_context_takeover

    _extensions = formatExtensions(_extensions);

    var headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey
    ];
    if (_extensions) {
      headers.push('Sec-WebSocket-Extensions: ' + _extensions);
    }

    socket.write(headers.join('\r\n') + '\r\n\r\n');

    self.emit('connection', new Socket(req, socket, head, extensions));
  });
}

Server.prototype.listen = function() {
  this._http.listen.apply(this._http, arguments);
};

function parseExtensions(req) {
  // e.g.
  //   Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits
  //   Sec-WebSocket-Extensions: x-webkit-deflate-frame

  var extensions = {};
  req.headers['sec-websocket-extensions'].split(';').forEach(function(extension) {
    // FIXME: value may be quoted. e.g. x="10"
    var parts = extension.trim().split('=');
    extensions[parts[0].toLowerCase()] = parts.length > 1 ? parts[1] : true;
  });
  return extensions;
}

function formatExtensions(extensions) {
  return Object.keys(extensions).map(function(extension) {
    var param = extensions[extension];
    return true === param ? extension : extension + '=' + param;
  }).join('; ');
}

function abortConnection(socket) {
  socket.write([
    'HTTP/1.1 400 Bad Request',
    'Content-type: text/html',
    'Sec-WebSocket-Version: 13'
  ].join('\r\n') + '\r\n\r\n');
  socket.destroy();
}
