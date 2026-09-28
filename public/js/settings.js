// Display settings, kept per device in localStorage. The font is the exception: it belongs to the
// reader's account and follows them to every device (the local copy lets pages start offline).
import { api } from './api.js';

const KEY = 'ereader.settings';
// 2: settings saved from here on carry this, so a stored light theme or serif font is a choice, not an old default.
const VERSION = 2;

// Bundled fonts come with the app (see server/fonts.js) and look the same on every device; `bundled`
// names their @fontsource package. Those marked `weights` come in every weight from regular to bold.
// The others are whatever the device has installed, so they vary between devices.
export const FONTS = [
  { id: 'literata', label: 'Literata', stack: 'Literata, Georgia, serif', bundled: 'literata', weights: true },
  { id: 'merriweather', label: 'Merriweather', stack: 'Merriweather, Georgia, serif', bundled: 'merriweather', weights: true },
  { id: 'baskerville', label: 'Libre Baskerville', stack: '"Libre Baskerville", Baskerville, Georgia, serif', bundled: 'libre-baskerville', weights: true },
  { id: 'bitter', label: 'Bitter', stack: 'Bitter, Georgia, serif', bundled: 'bitter', weights: true },
  { id: 'atkinson', label: 'Atkinson Hyperlegible', stack: '"Atkinson Hyperlegible", system-ui, sans-serif', bundled: 'atkinson-hyperlegible' },
  { id: 'opendyslexic', label: 'OpenDyslexic', stack: 'OpenDyslexic, "Comic Sans MS", sans-serif', bundled: 'opendyslexic' },
  { id: 'serif', label: 'Serif (device default)', stack: 'serif' },
  { id: 'georgia', label: 'Georgia', stack: 'Georgia, "Noto Serif", "DejaVu Serif", serif' },
  { id: 'charter', label: 'Charter / Iowan', stack: 'Charter, "Bitstream Charter", "Iowan Old Style", "Noto Serif", Georgia, serif' },
  { id: 'palatino', label: 'Palatino', stack: '"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", Georgia, serif' },
  { id: 'times', label: 'Times', stack: '"Times New Roman", Times, "Liberation Serif", "Noto Serif", serif' },
  { id: 'sans', label: 'Sans-serif (device default)', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Helvetica, Arial, sans-serif' },
  { id: 'helvetica', label: 'Helvetica / Arial', stack: 'Helvetica, Arial, "Liberation Sans", sans-serif' },
  { id: 'verdana', label: 'Verdana', stack: 'Verdana, Geneva, "DejaVu Sans", sans-serif' },
  { id: 'mono', label: 'Monospace', stack: 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace' },
];

/** The <option>s of a font menu: the bundled fonts first, then the device's own. */
export function fontOptions() {
  const group = (label, list) => `<optgroup label="${label}">${list.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}</optgroup>`;
  return group('Same on every device', FONTS.filter((f) => f.bundled)) + group('Installed on this device', FONTS.filter((f) => !f.bundled));
}

// Text weights, from the font's regular to its bold. Fonts marked `weights` are drawn with their own
// heavier faces. Other fonts get an outline instead, measured to add about as much ink per step;
// bold text is outlined too, so it stays bolder than the rest.
const WEIGHTS = [400, 500, 600, 700];
const OUTLINE = 0.015; // em per 100 of weight
const weightOf = (s) => (WEIGHTS.includes(s.weight) ? s.weight : DEFAULTS.weight);

/** The family that draws a font heavier ('Literata 600', see server/fonts.js), or null. */
function heavierFamily(font, weight) {
  return font.weights && weight > 400 ? `${font.stack.split(',')[0].replaceAll('"', '')} ${weight}` : null;
}

const sheets = new Map();
/** Adds the stylesheet with a heavier family, once. Resolves when it has loaded or failed. */
function heavierSheet(font, weight) {
  const href = `/css/fonts/${font.bundled}-${weight}.css`;
  if (!sheets.has(href)) {
    sheets.set(href, new Promise((resolve) => {
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href, onload: resolve, onerror: resolve }));
    }));
  }
  return sheets.get(href);
}

/**
 * Waits for a bundled font's files (a few seconds at most), so pages are measured in the font they
 * are shown in. Once downloaded they are kept for offline use.
 */
export function fontReady(s) {
  const font = FONTS.find((f) => f.id === s.font);
  if (!font?.bundled || !document.fonts?.load) return Promise.resolve();
  const heavier = heavierFamily(font, weightOf(s));
  const family = heavier ? `"${heavier}"` : font.stack.split(',')[0];
  const sheet = heavier ? heavierSheet(font, weightOf(s)) : Promise.resolve();
  const loads = sheet.then(() => Promise.all(['400', 'italic 400', '700'].map((style) => document.fonts.load(`${style} 16px ${family}`))));
  return Promise.race([loads, new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => {});
}

export const DEFAULTS = {
  theme: 'auto',        // light | sepia | dark | auto (follows the device)
  skin: 'auto',         // auto | soft | eink. auto: e-ink when high contrast is on or the device looks like an e-ink reader, else soft
  eink: false,
  font: 'literata',     // bundled with the app, so a new device looks like the others
  fontSize: 18,
  weight: 400,          // 400 normal | 500 medium | 600 semibold | 700 bold: heavier text reads darker on e-ink
  lineHeight: 1.5,
  margin: 'm',          // s | m | l
  align: 'justify',
  hyphens: true,
  swipe: true,
  tapZones: true,
  pdfMode: 'text',      // text | pages
  pdfInvert: true,
  columns: 'auto',      // auto | 1 | 2
  device: '',
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Before version 2 every setting was stored, so a light theme or serif font was usually just the old default.
    if (!s.v) {
      if (s.theme === 'light') delete s.theme;
      if (s.font === 'serif') delete s.font;
    }
    return { ...DEFAULTS, ...s };
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(s) {
  const out = { v: VERSION };
  for (const k of Object.keys(DEFAULTS)) if (s[k] !== undefined) out[k] = s[k];
  localStorage.setItem(KEY, JSON.stringify(out));
}

/**
 * Takes the account's font into this device's settings. Returns true when that changed the font.
 * Until the account has a font, the first device with one of its own chosen passes it on.
 */
export function adoptAccountFont(user) {
  const s = loadSettings();
  if (!user?.font) {
    if (user && s.font !== DEFAULTS.font) saveAccountFont(s.font);
    return false;
  }
  if (user.font === s.font || !FONTS.some((f) => f.id === user.font)) return false;
  saveSettings({ ...s, font: user.font });
  return true;
}

/** Saves the font to the account, for every device. Offline, it waits for the next change. */
export function saveAccountFont(font) {
  return api('/api/auth/me', { method: 'PATCH', body: { font }, noRedirect: true }).catch(() => {});
}

export function effectiveTheme(s) {
  if (s.theme === 'auto') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return s.theme;
}

/** E-ink readers, as their browser's user agent or the device name typed at sign-in ("Boox") names them. */
export const EINK_DEVICE = /boox|onyx|kobo|kindle|tolino|pocketbook|remarkable|bigme|hisense|meebook|e-?ink/i;

/**
 * The look of the app on this device: 'soft' (css/soft.css, for phones, tablets and laptops) or 'eink'
 * (black on white, thick lines, no motion). A look picked in the settings wins; until then an e-ink
 * reader, or a device with high contrast on, gets 'eink' and any other 'soft'. The script in the <head>
 * of every page repeats this, so a page never shows in the wrong look first: keep the two in step.
 */
export function resolveSkin(s) {
  if (s.skin === 'soft' || s.skin === 'eink') return s.skin;
  return s.eink || EINK_DEVICE.test(`${navigator.userAgent} ${s.device || ''}`) ? 'eink' : 'soft';
}

export function applyTheme(s) {
  const root = document.documentElement;
  root.dataset.theme = effectiveTheme(s);
  const skin = resolveSkin(s);
  root.dataset.skin = skin;
  // The high-contrast palette is part of the e-ink look; the soft look has none.
  if (skin === 'eink' && s.eink) root.dataset.eink = '1'; else delete root.dataset.eink;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor || '#fff';
}

export function applyTypography(s) {
  const root = document.documentElement.style;
  const font = FONTS.find((f) => f.id === s.font) || FONTS.find((f) => f.id === DEFAULTS.font);
  const weight = weightOf(s);
  const heavier = heavierFamily(font, weight);
  if (heavier) heavierSheet(font, weight);
  root.setProperty('--font-family', heavier ? `"${heavier}", ${font.stack}` : font.stack);
  root.setProperty('--text-stroke', font.weights ? '0' : `${+((weight - 400) / 100 * OUTLINE).toFixed(3)}em`);
  root.setProperty('--font-size', `${s.fontSize}px`);
  root.setProperty('--line-height', String(s.lineHeight));
  const margins = { s: [12, 14], m: [24, 28], l: [44, 40] }[s.margin] || [24, 28];
  // Scale margins up a little on wide screens so lines stay readable.
  const wide = Math.max(0, Math.min(1, (window.innerWidth - 600) / 800));
  root.setProperty('--margin-x', `${Math.round(margins[0] + wide * 60)}px`);
  root.setProperty('--margin-y', `${margins[1]}px`);
  root.setProperty('--text-align', s.align);
  root.setProperty('--hyphens', s.hyphens ? 'auto' : 'manual');
}
