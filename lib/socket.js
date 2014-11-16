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
  this._writeBuffer = [];
  this._readBuffer = [];
  this._writable = true;
  this._readable = true;
  this._buffer = new Buffer(0);
  this._header = null;
  this._payload = null;
  this._handler = this._decodeHeader;
  this._continuation = null;
  this._deflateEnabled = false;
  this._inflator = null;
  this._deflator = null;

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
    this._deflateEnabled = true;
  } else if (extensions['x-webkit-deflate-frame']) {
    this._extensions['x-webkit-deflate-frame'] = true;
    this._deflateEnabled = true;
  }

  var clientMaxWindowBits = extensions['client_max_window_bits'];
  if (clientMaxWindowBits) {
    this._extensions['client_max_window_bits'] = 'boolean' === typeof clientMaxWindowBits
      ? 15 : parseInt(clientMaxWindowBits, 10);
  }
  if (extensions['server_max_window_bits']) {
    this._extensions['server_max_window_bits'] = parseInt(extensions['server_max_window_bits'], 10);
  }
  if (extensions['client_no_context_takeover']) {
    this._extensions['client_no_context_takeover'] = true;
  }
  if (extensions['server_no_context_takeover']) {
    this._extensions['server_no_context_takeover'] = true;
  }

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
    var parts = extension.trim().split('=');
    var key = parts[0].toLowerCase();
    var value;
    if (parts.length > 1) {
      value = parts[1];
      if ('"' === value[0]) {
        value = value.slice(1);
      }
      if ('"' === value[value.length - 1]) {
        value = value.slice(0, value.length - 1);
      }
    } else {
      value = true;
    }
    extensions[key] = value;
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
  this._writeBuffer.push(data);
  this._flush();
};

Socket.prototype._flush = function() {
  if (!this._writable) return;
  if (!this._writeBuffer.length) return;

  this._writable = false;
  var data = this._writeBuffer.shift();
  var isBuffer = Buffer.isBuffer(data);
  if (!isBuffer) {
    data = new Buffer(data);
  }

  var self = this;

  if (this._deflateEnabled) {
    this._deflate(data, function(err, data) {
      if (err) return self.close(1002);
      send(data);
    });
  } else {
    send(data);
  }

  function send(payload) {
    self.socket.write(frame({
      rsv1: self._deflateEnabled,
      opcode: isBuffer ? 0x2 : 0x1,
      payload: payload
    }));
    self._writable = true;
    self._flush();
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
  this._buffer = Buffer.concat([this._buffer, data]);
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
    this._readBuffer.push({ header: header, payload: payload });
    this._handlePayload();
    break;
  case 0x8: // close
    if (1 === payload.length || (payload.length && !isValidErrorCode(payload.readUInt16BE(0)))) {
      this.close(1002);
      return;
    }
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
    this._handler();
    break
  case 0xa: // pong
    this._handler();
    break
  default:
    this.close(1002);
    return;
  }
};

Socket.prototype._handlePayload = function() {
  if (!this._readable) return;
  if (!this._readBuffer.length) return;

  this._readable = false;

  var data = this._readBuffer.shift();
  var self = this;

  if (this._deflateEnabled && data.header.rsv1) {
    this._inflate(data.payload, function(err, payload) {
      if (err) {
        console.error(err);
        self.close(1002);
        return;
      }
      onMessage(payload);
    });
  } else {
    onMessage(data.payload);
  }

  function onMessage(payload) {
    if (0x1 === data.header.opcode) {
      payload = payload.toString('utf8');
    }
    self.emit('message', payload);
    self._readable = true;
    self._handlePayload();
  }
};

Socket.prototype._inflate = function(data, callback) {
  if (!this._inflator || this._extensions['client_no_context_takeover']) {
    var clientMaxWindowBits = this._extensions['client_max_window_bits'];
    this._inflator = zlib.createInflateRaw({
      windowBits: 'number' === typeof clientMaxWindowBits ? clientMaxWindowBits : 15
    });
  }

  var self = this;
  var buffers = [];
  this._inflator
    .on('error', callback)
    .on('data', function(data) {
      buffers.push(data);
    });

  this._inflator.write(data);
  this._inflator.write(new Buffer([0x00, 0x00, 0xff, 0xff]));
  this._inflator.flush(function() {
    self._inflator.removeAllListeners('data');
    self._inflator.removeAllListeners('error');
    callback(null, Buffer.concat(buffers));
  });
};

Socket.prototype._deflate = function(data, callback) {
  if (!this._deflator || this._extensions['server_no_context_takeover']) {
    this._deflator = zlib.createDeflateRaw({
      flush: zlib.Z_SYNC_FLUSH,
      windowBits: this._extensions['server_max_window_bits'] || 15,
      memLevel: 8
    });
  }

  var self = this;
  var buffers = [];
  this._deflator
    .on('error', callback)
    .on('data', function(data) {
      buffers.push(data);
    });

  this._deflator.write(data);
  this._deflator.flush(function() {
    self._deflator.removeAllListeners('data');
    self._deflator.removeAllListeners('error');
    callback(null, Buffer.concat(buffers).slice(0, -4));
  });
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

function isValidErrorCode(code) {
  return (code >= 1000 && code <= 1011 && code != 1004 && code != 1005 && code != 1006) ||
       (code >= 3000 && code <= 4999);
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
