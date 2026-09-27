import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

function envInt(name, fallback) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT_DIR, 'data'));
  return {
    port: overrides.port ?? envInt('PORT', 8080),
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'rreader.sqlite'),
    booksDir: path.join(dataDir, 'books'),
    uploadsDir: path.join(dataDir, 'uploads'),
    // How long a login lasts. Devices such as an e-reader should stay signed in for a long time.
    sessionDays: overrides.sessionDays ?? envInt('SESSION_DAYS', 365),
    // When true anyone can create an account. The very first account can always be created.
    allowRegistration: overrides.allowRegistration ?? /^(1|true|yes)$/i.test(process.env.ALLOW_REGISTRATION ?? ''),
    // Maximum upload size in bytes.
    maxUploadBytes: overrides.maxUploadBytes ?? envInt('MAX_UPLOAD_MB', 500) * 1024 * 1024,
    // Set when the server is only reachable over https, so cookies are marked secure.
    secureCookies: overrides.secureCookies ?? /^(1|true|yes)$/i.test(process.env.SECURE_COOKIES ?? ''),
    trustProxy: overrides.trustProxy ?? /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ''),
  };
}
