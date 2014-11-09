var util = require('util');
var zlib = require('zlib');
var Duplex = require('stream').Duplex;

module.exports = Socket;

['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(v, i) {
  Socket.prototype[v] = Socket[v] = i;
});

util.inherits(Socket, Duplex);

function Socket(req, socket, head, extensions) {
  Duplex.call(this);

  this.req = req;
  this.socket = socket;
  this.extensions = extensions;
  this.readyState = Socket.CONNECTING;

  this._payloads = [];
  this._lastOpcode = null;
  this._deflate = !!(extensions['permessage-deflate'] || extensions['x-webkit-deflate-frame']);

  socket.on('data', this.handleData.bind(this));

  if (head.length) {
    this.handleData(head);
  }
}

Socket.prototype.send = function(data) {
  var self = this;
  encode(data, this._deflate, function(err, data) {
    if (err) throw err;
    self.socket.write(data);
  });
};

Socket.prototype.handleData = function(data) {
  var decoded = decode(data);

  // handle data
  this._payloads.push(decoded.payload);
  if (0 !== decoded.opcode) this._lastOpcode = decoded.opcode;
  if (!decoded.fin) return;

  var opcode = this._lastOpcode;
  this._lastOpcode = null;

  var payload = Buffer.concat(this._payloads);
  this._payloads = [];

  var self = this;

  switch (opcode) {
  case 0x1: // text
  case 0x2: // binary
    if (this._deflate) {
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
    this.readyState = Socket.CLOSING
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
    var fin = 1;
    var rsv1 = deflateEnabled ? 1 : 0;
    var opcode = isBuffer ? 0x2 : 0x1;
    var mask = 0;
    var payloadLen = payload.length;
    if (payloadLen >= 126) {
      throw new Error('Not implemented');
    }

    var header = new Buffer(2);
    header[0] = (fin << 7) ^ (rsv1 << 6) ^ opcode;
    header[1] = (mask << 7) ^ payloadLen;

    return Buffer.concat([header, payload]);
  }
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

