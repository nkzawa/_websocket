
test-local:
	@node_modules/.bin/zuul --local 3000 -- test/*.js

autobahn:
	@wstest -m fuzzingclient -s test/fuzzingclient.json

run-autobahn-server:
	@PORT=9001 node ./test/support/server.js

.PHONY: test autobahn
