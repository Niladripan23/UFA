'use strict';
const { createApplication } = require('../server');
const { RoomStore } = require('../roomStore');
const { testData } = require('./fixtures');
const port = Number(process.env.TEST_PORT);
const config = { port, redisUrl: process.env.TEST_REDIS_URL, allowedOrigins: ['http://localhost:' + port],
  ttlSeconds: 14400, graceMs: 1000, commit: 'integration-test' };
createApplication({ config, data: testData(), store: new RoomStore(config.redisUrl, process.env.TEST_PREFIX) })
  .then(application => {
    application.server.listen(port, '127.0.0.1', () => console.log('TEST_READY'));
    process.on('SIGTERM', () => application.close().then(() => process.exit(0)));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
