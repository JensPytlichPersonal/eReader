import { createApp } from './app.js';

const { app, config, processor, auth } = createApp();
processor.resumePending();
auth.purgeExpired();
setInterval(() => auth.purgeExpired(), 6 * 3600 * 1000).unref();

app.listen(config.port, config.host, () => {
  console.log(`rReader listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
});
