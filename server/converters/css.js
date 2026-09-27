// Filters publisher CSS down to the handful of typographic hints we keep so books
// render uniformly (font family, size, colours and layout are controlled by the reader).

const KEEP_PROPS = new Set([
  'text-align', 'text-indent', 'font-style', 'font-weight', 'font-variant', 'text-decoration',
  'text-transform', 'letter-spacing', 'white-space', 'list-style-type', 'list-style',
  'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding-left', 'padding-right',
  'vertical-align', 'display', 'page-break-before', 'page-break-after', 'break-before', 'break-after',
  'border-bottom', 'border-top', 'text-decoration-line',
]);

const DROP_DISPLAY = new Set(['none']); // publishers hide content with display:none; keep that intent
const LENGTH_RE = /^-?\d*\.?\d+(em|rem|%|px|pt|ex|ch)?$/;

function normalizeLength(prop, value) {
  // Convert px/pt to em so margins scale with the chosen font size.
  const parts = value.split(/\s+/).map((v) => {
    const m = v.match(/^(-?\d*\.?\d+)(px|pt)$/);
    if (!m) return v;
    const n = parseFloat(m[1]);
    const em = m[2] === 'px' ? n / 16 : n / 12;
    return `${Math.max(-4, Math.min(4, +em.toFixed(3)))}em`;
  });
  return parts.join(' ');
}

function filterDeclarations(decls) {
  const out = [];
  for (const d of decls.split(';')) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    const prop = d.slice(0, i).trim().toLowerCase();
    let value = d.slice(i + 1).trim().replace(/!important/gi, '').trim();
    if (!prop || !value) continue;
    if (!KEEP_PROPS.has(prop)) continue;
    if (prop === 'display' && !DROP_DISPLAY.has(value)) continue;
    if (/^(margin|padding)/.test(prop)) {
      if (!value.split(/\s+/).every((v) => LENGTH_RE.test(v) || v === 'auto')) continue;
      value = normalizeLength(prop, value);
    }
    if (prop === 'text-indent' && !LENGTH_RE.test(value)) continue;
    if (prop === 'text-indent') value = normalizeLength(prop, value);
    if (prop === 'letter-spacing' && !LENGTH_RE.test(value) && value !== 'normal') continue;
    if (/^border-(top|bottom)$/.test(prop)) value = value.replace(/#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+$/i, 'currentColor');
    if (prop === 'white-space' && !/^(normal|pre|pre-wrap|nowrap|pre-line)$/.test(value)) continue;
    out.push(`${prop}:${value}`);
  }
  return out;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Splits CSS into rules; unwraps @media blocks; drops other at-rules.
function* rules(css) {
  let i = 0;
  const n = css.length;
  while (i < n) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).trim();
    if (selector.startsWith('@')) {
      // at-rule: find matching brace
      let depth = 0;
      let j = open;
      for (; j < n; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
      }
      const body = css.slice(open + 1, j);
      if (/^@media\b/i.test(selector) && !/\b(print|speech|aural)\b/i.test(selector)) {
        yield* rules(body);
      }
      i = j + 1;
      continue;
    }
    const close = css.indexOf('}', open);
    if (close < 0) break;
    yield { selector, declarations: css.slice(open + 1, close) };
    i = close + 1;
  }
}

/**
 * Produce a scoped, filtered stylesheet for one section.
 * @param {string} css raw publisher css
 * @param {string} scope selector prefix such as `.sec`
 */
export function filterStylesheet(css, scope) {
  const out = [];
  for (const rule of rules(stripComments(css))) {
    const decls = filterDeclarations(rule.declarations);
    if (!decls.length) continue;
    const selectors = rule.selector.split(',').map((s) => s.trim()).filter(Boolean)
      .filter((s) => !/^(html|body|@|:root)/i.test(s) && !/[\[\]]/.test(s) || /^\w+\[/.test(s))
      .map((s) => s.replace(/^(html|body)\s*/i, ''))
      .filter((s) => s && s !== '*')
      .map((s) => `${scope} ${s}`);
    if (!selectors.length) continue;
    out.push(`${selectors.join(',')}{${decls.join(';')}}`);
  }
  return out.join('\n');
}

/** Filter an inline style="" attribute down to allowed properties. */
export function filterInlineStyle(style) {
  return filterDeclarations(style).join(';');
}
