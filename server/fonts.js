// Fonts that come with the app, so a book looks the same on every device. The @fontsource packages
// hold the files; their stylesheets are joined into one that points at /vendor/fonts. A browser only
// downloads a font when a page uses it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Must match the fonts marked `bundled` in public/js/settings.js.
const PACKAGES = ['literata', 'merriweather', 'libre-baskerville', 'bitter', 'atkinson-hyperlegible', 'opendyslexic'];
const STYLES = ['400', '400-italic', '700', '700-italic'];

/** The directory holding the @fontsource packages, served at /vendor/fonts. */
export const fontsDir = path.dirname(path.dirname(require.resolve('@fontsource/literata/package.json')));

/** One stylesheet with the @font-face rules of every bundled font. */
export function fontsCss() {
  return PACKAGES.flatMap((name) => STYLES.map((style) => {
    const file = path.join(fontsDir, name, `${style}.css`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replaceAll('url(./files/', `url(/vendor/fonts/${name}/files/`) : '';
  })).join('\n');
}
