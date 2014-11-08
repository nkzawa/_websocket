describe('_websocket', function() {
  var expect = require('expect.js');

  it('should connect', function(done) {
    var socket = new WebSocket('ws://' + location.host);
    socket.onopen = function(e) {
      done();
    };
  });

  it('should echo a short text data', function(done) {
    var socket = new WebSocket('ws://' + location.host);
    socket.onopen = function() {
      socket.send('hi');
    };
    socket.onmessage = function(e) {
      expect(e.data).to.be('hi');
      done();
    };
  });

  it('should echo a short binary data', function(done) {
    var data = new Int8Array(5);
    for (var i = 0; i < data.length; i++) {
      data[i] = i;
    }

    var socket = new WebSocket('ws://' + location.host);
    socket.binaryType = 'arraybuffer';
    socket.onopen = function() {
      socket.send(data);
    };
    socket.onmessage = function(e) {
      expect(new Int8Array(e.data)).to.eql(data);
      done();
    };
  });
});
