var websocket = require('../../');

var server = websocket.createServer(function(socket) {
  console.log('a new connection');
});

server.listen(process.env.ZUUL_PORT);
