// The ZIP writer for EPUB fixtures in tests: the server's own (writeZip in server/converters/zip.js),
// so the fixtures and the EPUB downloads share one writer.
export { writeZip as buildZip } from '../../server/converters/zip.js';

// 1x1 red PNG
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
