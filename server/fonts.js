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

/** A package's stylesheet for one style ('400-italic'), pointing at /vendor/fonts; '' when it has none. */
function styleCss(name, style) {
  const file = path.join(fontsDir, name, `${style}.css`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replaceAll('url(./files/', `url(/vendor/fonts/${name}/files/`) : '';
}

/** One stylesheet with the @font-face rules of every bundled font, and Literata's semibold for the soft skin's headings. */
export function fontsCss() {
  return [...PACKAGES.flatMap((name) => STYLES.map((style) => styleCss(name, style))), styleCss('literata', '600')].join('\n');
}

/**
 * A bundled font drawn heavier, for the text weight setting: a family of its own ('Literata 600')
 * with the same styles as above, each drawn with the face `weight - 400` heavier, or the heaviest
 * the font has. So its regular is Literata's semibold and its bold Literata's black, and a book's
 * bold text stays bolder than the rest. Null unless the font has every weight from 500 up to
 * `weight`: fonts with only a regular and a bold (the ones not marked `weights` in
 * public/js/settings.js) are drawn heavier with an outline instead.
 */
export function heavierFontCss(name, weight) {
  if (!PACKAGES.includes(name) || !(weight > 400) || weight % 100) return null;
  const weights = fs.readdirSync(path.join(fontsDir, name)).map((f) => Number(/^(\d+)\.css$/.exec(f)?.[1])).filter(Boolean);
  for (let w = 500; w <= weight; w += 100) if (!weights.includes(w)) return null;
  return STYLES.map((style) => {
    const [from, italic = ''] = style.split('-');
    const face = Math.max(...weights.filter((w) => w <= Number(from) + weight - 400));
    const css = styleCss(name, `${face}${italic && '-italic'}`);
    return css.replaceAll(/font-family: '([^']+)'/g, `font-family: '$1 ${weight}'`).replaceAll(`font-weight: ${face};`, `font-weight: ${from};`);
  }).join('\n');
}
