describe('_websocket', function() {
  var expect = require('expect.js');

  it('should connect', function(done) {
    var socket = new WebSocket('ws://' + location.host);
    socket.onopen = function(e) {
      done();
    };
    socket.onerror = function(err) {
      done(err);
    };
  });
});
