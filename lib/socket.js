var util = require('util');
var zlib = require('zlib');
var crypto = require('crypto');
var Duplex = require('stream').Duplex;

module.exports = Socket;

util.inherits(Socket, Duplex);

['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(v, i) {
  Socket.prototype[v] = Socket[v] = i;
});

function Socket(req, socket, head) {
  Duplex.call(this);

  this.req = req;
  this.socket = socket;
  this.readyState = this.CONNECTING;

  this._extensions = {};
  this._buffer = head;
  this._header = null;
  this._payload = null;
  this._handler = this._decodeHeader;
  this._continuation = null;
  this._deflate = false;

  socket.on('data', this._handleData.bind(this));

  if (this._buffer.length) {
    this.on('connect', function() {
      this._handleData();
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
  var isBuffer = Buffer.isBuffer(data);
  if (!isBuffer) {
    data = new Buffer(data, 'utf8');
  }

  var self = this;

  if (this._deflate) {
    deflate(data, function(err, data) {
      if (err) return self.close(1002);
      self.socket.write(encode(data));
    });
  } else {
    this.socket.write(encode(data));
  }

  function encode(payload) {
    return frame({
      rsv1: self._deflate,
      opcode: isBuffer ? 0x2 : 0x1,
      payload: payload
    });
  }
};

Socket.prototype.sendClose = function(code, message) {
  code = code || 1000;
  message = message || '';

  var payload = new Buffer(2 + Buffer.byteLength(message, 'utf8'));
  payload.writeUInt16BE(code, 0);
  payload.write(message, 2);

  var data = frame({
    opcode: 0x8,
    payload: payload
  });
  this.socket.write(data);
};

Socket.prototype.sendPong = function(payload) {
  var data = frame({ opcode: 0xa, payload: payload });
  this.socket.write(data);
};

Socket.prototype.close = function(code) {
  if (this.OPEN !== this.readyState) return;

  this.readyState = this.CLOSING;
  this.sendClose(code);
};

Socket.prototype._handleData = function(data) {
  if (data) {
    this._buffer = Buffer.concat([this._buffer, data]);
  }
  this._handler();
};

Socket.prototype._decodeHeader = function() {
  if (2 > this._buffer.length) return;

  // parse packet
  // see: http://tools.ietf.org/html/rfc6455#section-5.2
  var buffer = this._buffer;
  var fin = (buffer[0] & parseInt('10000000', 2)) >> 7;
  var rsv1 = (buffer[0] & parseInt('01000000', 2)) >> 6;
  var rsv2 = (buffer[0] & parseInt('00100000', 2)) >> 5;
  var rsv3 = (buffer[0] & parseInt('00010000', 2)) >> 4;
  var opcode = buffer[0] & parseInt('00001111', 2);
  var mask = (buffer[1] & parseInt('10000000', 2)) >> 7;
  var payloadLen = buffer[1] & parseInt('01111111', 2);

  // non control frame
  if (0x0 === opcode && !this._continuation
    || (0x1 === opcode || 0x2 === opcode) && this._continuation) {
    this.close(1002);
    return;
  }

  // control frame
  if (opcode >= 0x8) {
    if (payloadLen >= 126) {
      // control frame should have payload no more than 125.
      this.close(1002);
      return;
    }
    if (!fin) {
      this.close(1002);
      return;
    }
  }

  if (!Object.keys(this._extensions).length && (rsv1 || rsv2 || rsv3)) {
    // no rsv when no extensions
    this.close(1002);
    return;
  }

  this._header = {
    fin: fin,
    rsv1: rsv1,
    opcode: opcode,
    mask: mask,
    payloadLen: payloadLen
  };

  if (!fin && 0x0 !== opcode) {
    this._continuation = {
      header: this._header,
      payloads: []
    };
  }

  this._buffer = this._buffer.slice(2);

  switch (payloadLen) {
  case 126:
  case 127:
    this._handler = this._decodeExtendedLength;
    break;
  default:
    this._handler = mask ? this._decodeMaskingKey : this._decodePayload;
    break;
  }
  this._handler();
};

Socket.prototype._decodeExtendedLength = function() {
  var payloadLen = this._header.payloadLen;
  var expected = 126 === payloadLen ? 2 : 8;
  if (expected > this._buffer.length) return;

  if (126 === payloadLen) {
    this._header.payloadLen = this._buffer.readUInt16BE(0);
  } else {
    this._header.payloadLen = readUInt64BE.call(this._buffer, 0);
  }
  this._buffer = this._buffer.slice(expected);
  this._handler = this._header.mask ? this._decodeMaskingKey : this._decodePayload;
  this._handler();
};

Socket.prototype._decodeMaskingKey = function() {
  if (4 > this._buffer.length) return;

  this._header.maskingKey = this._buffer.slice(0, 4);
  this._buffer = this._buffer.slice(4);
  this._handler = this._decodePayload;
  this._handler();
};

Socket.prototype._decodePayload = function() {
  var payloadLen = this._header.payloadLen;
  if (payloadLen > this._buffer.length) return;

  var payload = this._buffer.slice(0, payloadLen);
  this._buffer = this._buffer.slice(payloadLen);
  this._handler = this._decodeHeader;

  if (this._header.mask) {
    payload = unmask(payload, this._header.maskingKey);
  }

  if (!this._header.fin || 0x0 === this._header.opcode) {
    this._continuation.payloads.push(payload);
  }
  this._payload = payload;
  this._handleFrame();
}

Socket.prototype._handleFrame = function() {
  var header = this._header;
  var payload = this._payload;
  var self = this;

  this._header = null;
  this._payload = null;

  if (!header.fin) return this._handler();

  if (0x0 === header.opcode) {
    header = this._continuation.header;
    payload = Buffer.concat(this._continuation.payloads);
    this._continuation = null;
  }

  switch (header.opcode) {
  case 0x1: // text
  case 0x2: // binary
    if (this._deflate && header.rsv1) {
      inflate(payload, function(err, payload) {
        if (err) {
          console.error(err);
          self.close(1002);
          return;
        }
        onMessage(payload);
      });
    } else {
      onMessage(payload);
    }

    function onMessage(payload) {
      if (0x1 === header.opcode) {
        payload = payload.toString('utf8');
      }
      self.emit('message', payload);
    }
    break;
  case 0x8: // close
    if (this.OPEN === this.readyState) {
      this.sendClose();
    }
    this.socket.end();
    this.readyState = this.CLOSED;
    break
  case 0x9: // ping
    if (this.OPEN === this.readyState) {
      this.sendPong(payload);
    }
    break
  case 0xa: // pong
    break
  default:
    this.close(1002);
  }

  this._handler();
};

function frame(data) {
  var fin = (data.fin || 'undefined' === typeof data.fin) ? 1 : 0;
  var rsv1 = data.rsv1 ? 1 : 0;
  var opcode = data.opcode;
  var mask = 0;
  var payload = data.payload || new Buffer(0);
  var payloadLen = payload.length;
  var extended;
  if (126 <= payloadLen) {
    if (0x10000 > payloadLen) {
      extended = new Buffer(2);
      extended.writeUInt16BE(payloadLen, 0);
      payloadLen = 126;
    } else {
      extended = new Buffer(8);
      writeUInt64BE.call(extended, payloadLen, 0);
      payloadLen = 127;
    }
  }

  var header = new Buffer(2);
  header[0] = (fin << 7) ^ (rsv1 << 6) ^ opcode;
  header[1] = (mask << 7) ^ payloadLen;

  var buffers = [];
  buffers.push(header);
  if (extended) {
    buffers.push(extended);
  }
  buffers.push(payload);

  return Buffer.concat(buffers);
}

function decodeExtendedLen() {
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

function unmask(data, maskingKey) {
  var length = data.length;
  var decoded = new Buffer(length);
  for (var i = 0; i < length; i++) {
    decoded[i] = data[i] ^ maskingKey[i % 4];
  }
  return decoded;
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

function readUInt64BE(offset, noAssert) {
  var high = this.readUInt32BE(offset, noAssert);
  var low = this.readUInt32BE(offset + 4, noAssert);
  return high * 0x100000000 + low;
}

function writeUInt64BE(value, offset, noAssert) {
  this.writeUInt32BE(Math.floor(value / 0x100000000), offset, noAssert);
  this.writeUInt32BE(value % 0x100000000, offset + 4, noAssert);
  return offset + 4;
}
