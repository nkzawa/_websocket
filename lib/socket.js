var util = require('util');
var Duplex = require('stream').Duplex;

module.exports = Socket;

['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(v, i) {
  Socket.prototype[v] = Socket[v] = i;
});

util.inherits(Socket, Duplex);

function Socket(req, socket) {
  Duplex.call(this);

  this._req = req;
  this._socket = socket;
  this._payloads = [];
  this._lastOpcode = null;
  this.readyState = Socket.CONNECTING;

  socket.on('data', this.handleData.bind(this));
}

Socket.prototype.send = function(data) {
  this._socket.write(encode(data));
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

  switch (opcode) {
  case 0x1: // text
    payload = payload.toString('utf8');
    this.emit('message', payload);
    break;
  case 0x2: // binary
    this.emit('message', payload);
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
    opcode: opcode,
    payload: payload
  };
}

function encode(payload) {
  var isBuffer = Buffer.isBuffer(payload);
  if (!isBuffer) {
    payload = new Buffer(payload, 'utf8');
  }

  var fin = 1;
  var opcode = isBuffer ? 0x2 : 0x1;
  var mask = 0;
  var payloadLen = payload.length;
  if (payloadLen >= 126) {
    throw new Error('Not implemented');
  }

  var head = new Buffer(2);
  head[0] = (fin << 7) ^ opcode;
  head[1] = (mask << 7) ^ payloadLen;
  return Buffer.concat([head, payload]);
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

