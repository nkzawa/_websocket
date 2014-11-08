var websocket = require('../../');

var server = websocket.createServer(function(socket) {
  socket.on('message', function(data) {
    // echo data
    socket.send(data);
  });
});

server.listen(process.env.ZUUL_PORT);
