import { createApp } from './app.js';

const { app, config, processor, auth, lookups, duplicates } = createApp();
processor.resumePending();
processor.backfillMetadata().catch((err) => console.error(`[metadata] ${err.message}`));
duplicates.backfillFingerprints().catch((err) => console.error(`[fingerprint] ${err.message}`));
auth.purgeExpired();
setInterval(() => auth.purgeExpired(), 6 * 3600 * 1000).unref();

app.listen(config.port, config.host, () => {
  console.log(`eReader listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
  console.log(`Books are looked up in ${lookups.sources.includes('hardcover') ? 'Hardcover and Open Library' : 'Open Library (set HARDCOVER_TOKEN to add Hardcover)'}`);
});
