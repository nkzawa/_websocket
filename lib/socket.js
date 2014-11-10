var util = require('util');
var zlib = require('zlib');
var crypto = require('crypto');
var Duplex = require('stream').Duplex;

module.exports = Socket;

['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(v, i) {
  Socket.prototype[v] = Socket[v] = i;
});

util.inherits(Socket, Duplex);

function Socket(req, socket, head) {
  Duplex.call(this);

  this.req = req;
  this.socket = socket;
  this.readyState = this.CONNECTING;

  this._extensions = {};
  this._payloads = [];
  this._lastOpcode = null;
  this._lastRsv1 = null;
  this._deflate = false;

  socket.on('data', this._handleData.bind(this));

  if (head.length) {
    this.on('connect', function() {
      this._handleData(head);
    });
  }
}

Socket.prototype.upgrade = function(callback) {
  if (!this.req.headers.upgrade || 'websocket' !== this.req.headers.upgrade.toLowerCase()) {
    callback(new Error());
    this._abortConnection();
    return;
  }

  var version = parseInt(this.req.headers['sec-websocket-version'], 10);
  if (13 !== version) {
    callback(new Error());
    this._abortConnection();
    return;
  }

  var key = this.req.headers['sec-websocket-key'];
  if (!key) {
    callback(new Error());
    this._abortConnection();
    return;
  }

  var acceptKey = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  var extensions = this._parseExtensions();
  if (extensions['permessage-deflate']) {
    this._extensions['permessage-deflate'] = true;
    this._deflate = true;
  } else if (extensions['x-webkit-deflate-frame']) {
    this._extensions['x-webkit-deflate-frame'] = true;
    this._deflate = true;
  }

  // TODO:
  //   client_max_window_bits
  //   server_max_window_bits
  //   client_no_context_takeover
  //   server_no_context_takeovero

  var formattedExtensions = this._formatExtensions();

  var headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey
  ];
  if (formattedExtensions) {
    headers.push('Sec-WebSocket-Extensions: ' + formattedExtensions);
  }

  this.socket.write(headers.join('\r\n') + '\r\n\r\n');

  this.readyState = this.OPEN;

  callback(null, this);
  this.emit('connect');
};

Socket.prototype._parseExtensions = function() {
  // e.g.
  //   Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits
  //   Sec-WebSocket-Extensions: x-webkit-deflate-frame

  var extensions = {};
  (this.req.headers['sec-websocket-extensions'] || '').split(';').forEach(function(extension) {
    // FIXME: value may be quoted. e.g. x="10"
    var parts = extension.trim().split('=');
    extensions[parts[0].toLowerCase()] = parts.length > 1 ? parts[1] : true;
  });
  return extensions;
};

Socket.prototype._formatExtensions = function() {
  return Object.keys(this._extensions).map(function(extension) {
    var param = this._extensions[extension];
    return true === param ? extension : extension + '=' + param;
  }, this).join('; ');
};

Socket.prototype._abortConnection = function() {
  this.socket.write([
    'HTTP/1.1 400 Bad Request',
    'Content-type: text/html',
    'Sec-WebSocket-Version: 13'
  ].join('\r\n') + '\r\n\r\n');
  this.socket.destroy();
};

Socket.prototype.send = function(data) {
  var self = this;
  encode(data, this._deflate, function(err, data) {
    if (err) throw err;
    self.socket.write(data);
  });
};

Socket.prototype.sendClose = function(code, message) {
  code = code || 1000;
  message = message || '';

  var payload = new Buffer(2 + Buffer.byteLength(message, 'utf8'));
  payload.writeUInt16BE(code, 0);
  payload.write(message, 2);

  return frame({
    opcode: 0x8,
    payload: payload
  });
};

Socket.prototype.close = function() {
  if (this.OPEN !== this.readyState) return;

  this.readyState = this.CLOSING;
  this.sendClose();
};

Socket.prototype._handleData = function(data) {
  var decoded = decode(data);

  // handle data
  this._payloads.push(decoded.payload);
  if (decoded.opcode) this._lastOpcode = decoded.opcode;
  if (decoded.rsv1) this._lastRsv1 = decoded.rsv1;
  if (!decoded.fin) return;

  var opcode = this._lastOpcode;
  this._lastOpcode = null;

  var rsv1 = this._lastRsv1;
  this._lastRsv1 = null;

  var payload = Buffer.concat(this._payloads);
  this._payloads = [];

  var self = this;

  switch (opcode) {
  case 0x1: // text
  case 0x2: // binary
    if (this._deflate && rsv1) {
      inflate(payload, function(err, payload) {
        onMessage(payload);
      });
    } else {
      onMessage(payload);
    }

    function onMessage(payload) {
      if (0x01 === opcode) {
        payload = payload.toString('utf8');
      }
      self.emit('message', payload);
    }
    break;
  case 0x8: // close
    if (this.OPEN === this.readyState) {
      this.sendClose();
    }
    this.readyState = this.CLOSED;
    break
  case 0x9: // ping
  case 0xa: // pong
    break
  default:
    throw new Error('Unsupported opcode: ' + opcode);
  }
};

function decode(data) {
  // parse packet
  // see: http://tools.ietf.org/html/rfc6455#section-5.2
  var offset = 0;
  var fin = (data[offset] & parseInt('10000000', 2)) >> 7;
  var rsv1 = (data[offset] & parseInt('01000000', 2)) >> 6;
  var opcode = data[offset] & parseInt('00001111', 2);
  offset++;

  var mask = (data[offset] & parseInt('10000000', 2)) >> 7;
  var payloadLen = data[offset] & parseInt('01111111', 2);
  offset++;

  if (126 === payloadLen) {
    payloadLen = data.readUInt16BE(offset);
    offset += 2;
  } else if (127 === payloadLen) {
    payloadLen = readUInt64BE.call(data, offset);
    offset += 8;
  }

  var maskingKey;
  if (mask) {
    maskingKey = data.slice(offset, offset + 4);
    offset += 4;
  }

  var payload = data.slice(offset, offset + payloadLen);

  if (mask) {
    payload = unmask(payload, maskingKey);
  }

  return {
    fin: fin,
    rsv1: rsv1,
    opcode: opcode,
    payload: payload
  };
}

function encode(data, deflateEnabled, callback) {
  var isBuffer = Buffer.isBuffer(data);
  if (!isBuffer) {
    data = new Buffer(data, 'utf8');
  }

  if (deflateEnabled) {
    deflate(data, function(err, data) {
      if (err) return callback(err);
      callback(null, encode(data));
    });
  } else {
    callback(null, encode(data));
  }

  function encode(payload) {
    return frame({
      rsv1: deflateEnabled,
      opcode: isBuffer ? 0x2 : 0x1,
      payload: payload
    });
  }
}

function frame(data) {
  var fin = (data.fin || 'undefined' === typeof data.fin) ? 1 : 0;
  var rsv1 = data.rsv1 ? 1 : 0;
  var opcode = data.opcode;
  var mask = data.mask ? 1 : 0;
  var payload = data.payload || new Buffer(0);

  var header = new Buffer(2);
  header[0] = (fin << 7) ^ (rsv1 << 6) ^ opcode;
  header[1] = (mask << 7) ^ payload.length;

  return Buffer.concat([header, payload]);
}

function unmask(data, maskingKey) {
  var length = data.length;
  var decoded = new Buffer(length);
  for (var i = 0; i < length; i++) {
    decoded[i] = data[i] ^ maskingKey[i % 4];
  }
  return decoded;
}

function readUInt64BE(offset) {
  var high = this.readUInt32BE(offset);
  var low = this.readUInt32BE(offset + 4);
  return high * 0x100000000 + low;
}

function inflate(data, callback) {
  var buffers = [];
  zlib
    .createInflateRaw({ windowBits: 15 })
    .on('data', function(chunk) {
      buffers.push(chunk);
    })
    .on('end', function() {
      callback(null, Buffer.concat(buffers));
    })
    .on('error', callback)
    .end(data);
}

function deflate(data, callback) {
  var buffers = [];
  zlib
    .createDeflateRaw({ windowBits: 15, memLevel: 8 })
    .on('data', function(chunk) {
      buffers.push(chunk);
    })
    .on('end', function() {
      callback(null, Buffer.concat(buffers));
    })
    .on('error', callback)
    .end(data);
}

