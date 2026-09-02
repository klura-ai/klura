const path = require('node:path');

const routesPath = path.resolve(__dirname, '..', '..', 'dist', 'consumer', 'daemon-routes.js');
const routes = require(routesPath);

routes.ConsumerDaemonRoutesV1 = class ConsumerDaemonRoutesV1 {
  async invoke() {
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    return { kind: 'consumer_daemon_test_result' };
  }
};
