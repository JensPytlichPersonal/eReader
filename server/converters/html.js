// Normalises arbitrary (X)HTML into the small, predictable subset the reader renders.
import { parseDocument, DomUtils, ElementType } from 'htmlparser2';
import render from 'dom-serializer';
import { filterInlineStyle } from './css.js';
import { hasWatermark, stripWatermarks, isWatermarkLink, isCreditLine, CREDIT_REACH } from './watermarks.js';

const { isTag, isText, textContent, removeElement, replaceElement, getElementsByTagName, findOne } = DomUtils;

// public/js/reader.js keeps a copy of this list to count paragraphs as fixes.js does; the two must stay in step.
export const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'figure', 'figcaption',
  'hr', 'br', 'img', 'address', 'details', 'summary', 'hgroup']);
const INLINE_TAGS = new Set(['a', 'em', 'strong', 'i', 'b', 'u', 's', 'small', 'sub', 'sup', 'span', 'code', 'kbd',
  'samp', 'var', 'cite', 'q', 'abbr', 'dfn', 'mark', 'time', 'del', 'ins', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr']);
const REMOVE_WITH_CONTENT = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'iframe', 'object', 'embed',
  'video', 'audio', 'form', 'input', 'button', 'select', 'textarea', 'canvas', 'noscript', 'template', 'math', 'base']);
const RENAME = { center: 'div', font: 'span', big: 'span', tt: 'code', strike: 's', acronym: 'abbr', blink: 'span', nobr: 'span' };
const WRAPPER_TAGS = new Set(['div', 'section', 'article', 'main', 'body', 'blockquote', 'aside', 'header', 'footer', 'nav', 'hgroup']);
const KEEP_ATTRS = new Set(['id', 'class', 'alt', 'title', 'colspan', 'rowspan', 'lang', 'dir', 'start', 'reversed', 'type', 'value', 'role', 'span', 'headers', 'scope', 'datetime', 'cite']);

const HEADING_RE = /^h[1-6]$/;
// Blocks that hold a paragraph of their own, and may be taken for a scene break or a credit line.
const PARAGRAPH_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const NOT_PARAGRAPHS = new Set(['br', 'hr', 'img']);
const holdsBlocks = (el) => el.children.some((c) => isTag(c) && BLOCK_TAGS.has(c.name) && !NOT_PARAGRAPHS.has(c.name));

// A paragraph holding nothing but a mark such as "* * *", "***", "#" or "~" is a break between scenes, as are
// three or more dots or bullets ("• • •"; one alone is a bullet). Every format gives this one element for it.
const SCENE_BREAK_RE = /^(?:[*#~⁂]\s*)+$|^(?:[•·]\s*){3,}$/u;
export const SCENE_BREAK = '<hr class="scene-break"/>';
export const isSceneBreak = (text) => SCENE_BREAK_RE.test(text.trim());

export function isEmptyNode(node) {
  if (isText(node)) return /^\s*$/.test(node.data);
  if (!isTag(node)) return true;
  if (node.attribs?.id) return false;
  if (node.name === 'img' || node.name === 'br' || node.name === 'hr' || node.name === 'td' || node.name === 'th') return false;
  return node.children.every(isEmptyNode);
}

/**
 * @typedef {object} NormalizeOptions
 * @property {(src: string) => string|null} [resolveImage] maps an image reference to a bundle path (`images/x.jpg`) or null to drop
 * @property {(href: string) => string|null} [resolveLink] maps an internal link to a canonical key (later resolved to a section) or null
 * @property {string} [idPrefix] prefix for generated ids
 */

/**
 * Parse and normalise a chapter document. Returns a DOM whose root children are the body content.
 * @param {string} html
 * @param {NormalizeOptions} opts
 */
export function normalizeDocument(html, opts = {}) {
  const isXml = /^\s*<\?xml/i.test(html) || /xmlns=["']http:\/\/www\.w3\.org\/1999\/xhtml/i.test(html);
  const doc = parseDocument(html, { xmlMode: false, decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: isXml });
  const body = findOne((el) => el.name === 'body', doc.children, true);
  const rootNodes = body ? body.children : doc.children;
  const container = { type: ElementType.Tag, name: 'div', attribs: {}, children: [], parent: null };
  for (const n of rootNodes) { n.parent = container; container.children.push(n); }

  const state = { images: new Set(), idCounter: 0, opts, ids: new Set() };
  cleanNode(container, state);
  removeWatermarks(container);
  markSceneBreaks(container);
  // Drop leading/trailing empty nodes
  while (container.children.length && isEmptyNode(container.children[0])) container.children.shift();
  while (container.children.length && isEmptyNode(container.children[container.children.length - 1])) container.children.pop();
  return { root: container, images: [...state.images] };
}

function cleanNode(node, state) {
  const children = [...node.children];
  for (const child of children) {
    if (isText(child)) continue;
    if (child.type === ElementType.Comment || child.type === ElementType.Directive || child.type === ElementType.CDATA) {
      removeElement(child);
      continue;
    }
    if (!isTag(child)) { removeElement(child); continue; }
    let name = child.name.toLowerCase();
    if (name.includes(':')) {
      // namespaced elements (mbp:pagebreak, epub:switch, svg content, ...)
      if (name === 'mbp:pagebreak') { child.name = 'hr'; child.attribs = { class: 'pagebreak' }; child.children = []; continue; }
      if (name === 'epub:switch') { unwrapSwitch(child); cleanNode(node, state); return; }
      name = name.split(':').pop();
    }
    if (REMOVE_WITH_CONTENT.has(name)) { removeElement(child); continue; }
    if (name === 'svg') { replaceSvg(child, state); continue; }
    if (name === 'image' && child.attribs) { // stray svg image element
      const href = child.attribs['xlink:href'] || child.attribs.href;
      if (href) { child.name = 'img'; child.attribs = { src: href }; child.children = []; }
      else { removeElement(child); continue; }
      name = 'img';
    }
    if (RENAME[name]) {
      const from = name;
      name = RENAME[name];
      child.name = name;
      if (from === 'center') child.attribs = { ...child.attribs, style: `text-align:center;${child.attribs.style || ''}` };
      if (from === 'big') child.attribs = { ...child.attribs, style: `font-size:1.2em;${child.attribs.style || ''}` };
    }
    if (!BLOCK_TAGS.has(name) && !INLINE_TAGS.has(name)) {
      // Unknown element: keep its children in place.
      cleanNode(child, state);
      const idx = node.children.indexOf(child);
      for (const gc of child.children) gc.parent = node;
      node.children.splice(idx, 1, ...child.children);
      continue;
    }
    child.name = name;
    cleanAttributes(child, state);
    if (name === 'img') {
      const src = child.attribs.src;
      const resolved = src && state.opts.resolveImage ? state.opts.resolveImage(src) : null;
      if (!resolved) { removeElement(child); continue; }
      state.images.add(resolved);
      child.attribs['data-src'] = resolved;
      delete child.attribs.src;
      child.attribs.loading = 'lazy';
      if (!child.attribs.alt) child.attribs.alt = '';
    }
    if (name === 'a') {
      const href = child.attribs.href;
      delete child.attribs.href;
      if (href) {
        if (/^(https?:|mailto:)/i.test(href)) {
          child.attribs.href = href;
          child.attribs.target = '_blank';
          child.attribs.rel = 'noopener';
        } else if (state.opts.resolveLink) {
          const key = state.opts.resolveLink(href);
          if (key) child.attribs['data-link'] = key;
        }
      }
    }
    cleanNode(child, state);
    // Remove empty inline wrappers that carry nothing.
    if (INLINE_TAGS.has(name) && name !== 'a' && name !== 'wbr' && !child.attribs.id && child.children.length === 0) {
      removeElement(child);
    }
  }
}

/** Take out download-site watermarks (see watermarks.js) and the elements they leave empty. */
function removeWatermarks(root) {
  const touched = [];
  const visit = (node) => {
    for (const child of [...node.children]) {
      if (isText(child)) {
        if (!hasWatermark(child.data)) continue;
        child.data = stripWatermarks(child.data);
        if (!child.data) removeElement(child);
        touched.push(node);
      } else if (isTag(child)) {
        if (child.name === 'a' && isWatermarkLink(child.attribs.href || '')) {
          // Unlink rather than delete, so nothing but the watermark text itself is lost.
          child.name = 'span';
          for (const k of ['href', 'target', 'rel']) delete child.attribs[k];
          touched.push(child);
        }
        visit(child);
      }
    }
  };
  visit(root);
  for (let node of touched) {
    while (node !== root && node.parent && isEmptyNode(node)) {
      const parent = node.parent;
      removeElement(node);
      node = parent;
    }
  }
}

/**
 * Paragraphs that are only a scene-break mark (see isSceneBreak) become the scene-break element, keeping
 * their id for links. One that holds a link, a note marker, a picture or an id further in stays as it is.
 */
function markSceneBreaks(node) {
  const keep = (e) => e.name === 'a' || e.name === 'sup' || e.name === 'img' || !!e.attribs.id;
  for (const child of node.children) {
    if (!isTag(child)) continue;
    if (PARAGRAPH_TAGS.has(child.name) && !holdsBlocks(child) && isSceneBreak(textContent(child)) && !findOne(keep, child.children, true)) {
      child.name = 'hr';
      child.attribs = { class: 'scene-break', ...(child.attribs.id ? { id: child.attribs.id } : {}) };
      child.children = [];
    } else markSceneBreaks(child);
  }
}

/**
 * Take out the credit lines of scanners and download sites (see isCreditLine in watermarks.js): whole
 * paragraphs among the first CREDIT_REACH of a book, whose chapters `roots` are in reading order. Only the
 * whole book tells where it starts, so this runs as the sections are assembled. A paragraph holding an id,
 * such as a PDF page marker or a link target, stays.
 */
export function removeCreditLines(roots) {
  let seen = 0;
  const visit = (root, node) => {
    for (const child of [...node.children]) {
      if (seen >= CREDIT_REACH) return;
      if (!isTag(child) || !BLOCK_TAGS.has(child.name) || NOT_PARAGRAPHS.has(child.name)) continue;
      if (holdsBlocks(child)) { visit(root, child); continue; }
      const text = textContent(child);
      if (!text.trim()) continue;
      seen++;
      if (!PARAGRAPH_TAGS.has(child.name) || !isCreditLine(text) || child.attribs.id || findOne((e) => !!e.attribs.id || e.name === 'img', child.children, true)) continue;
      let parent = child.parent;
      removeElement(child);
      while (parent !== root && parent.parent && isEmptyNode(parent)) {
        const up = parent.parent;
        removeElement(parent);
        parent = up;
      }
    }
  };
  for (const root of roots) {
    if (seen >= CREDIT_REACH) break;
    visit(root, root);
  }
}

function unwrapSwitch(el) {
  // <epub:switch><epub:case>...</epub:case><epub:default>...</epub:default></epub:switch> -> default branch
  const def = findOne((n) => n.name === 'epub:default', el.children, true);
  const keep = def ? def.children : [];
  const parent = el.parent;
  const idx = parent.children.indexOf(el);
  for (const k of keep) k.parent = parent;
  parent.children.splice(idx, 1, ...keep);
}

function replaceSvg(svg, state) {
  const img = findOne((n) => n.name === 'image', svg.children, true);
  const href = img && (img.attribs['xlink:href'] || img.attribs.href);
  const resolved = href && state.opts.resolveImage ? state.opts.resolveImage(href) : null;
  if (resolved) {
    state.images.add(resolved);
    const el = { type: ElementType.Tag, name: 'img', attribs: { 'data-src': resolved, alt: img.attribs.alt || '', loading: 'lazy' }, children: [], parent: svg.parent };
    if (svg.attribs.id) el.attribs.id = svg.attribs.id;
    replaceElement(svg, el);
  } else {
    // Inline vector art cannot be normalised; keep any text inside it.
    const text = textContent(svg).trim();
    if (text) {
      const p = { type: ElementType.Tag, name: 'p', attribs: {}, children: [], parent: svg.parent };
      p.children.push({ type: ElementType.Text, data: text, parent: p });
      replaceElement(svg, p);
    } else removeElement(svg);
  }
}

function cleanAttributes(el, state) {
  const out = {};
  for (const [k, v] of Object.entries(el.attribs || {})) {
    const key = k.toLowerCase();
    if (KEEP_ATTRS.has(key)) {
      if (key === 'type' && el.name !== 'ol' && el.name !== 'ul') continue;
      if (key === 'value' && el.name !== 'li') continue;
      out[key] = v;
    } else if (key === 'style') {
      const s = filterInlineStyle(v);
      if (s) out.style = s;
    } else if (key === 'src' || key === 'href' || key === 'xlink:href') {
      out[key === 'xlink:href' ? 'href' : key] = v;
    } else if (key === 'epub:type') {
      out['data-type'] = v;
    } else if (key === 'align' && /^(left|right|center|justify)$/i.test(v)) {
      out.style = `text-align:${v.toLowerCase()};${out.style || ''}`;
    }
  }
  if (out.id) {
    if (state.ids.has(out.id)) delete out.id; else state.ids.add(out.id);
  }
  el.attribs = out;
}

/** Ensure every heading has an id; return list of headings in document order. */
export function collectHeadings(root, idPrefix = 'rr') {
  const headings = [];
  let n = 0;
  for (const el of DomUtils.findAll((e) => HEADING_RE.test(e.name), root.children)) {
    const text = textContent(el).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!el.attribs.id) el.attribs.id = `${idPrefix}-h${++n}`;
    headings.push({ level: parseInt(el.name[1], 10), text: text.slice(0, 200), id: el.attribs.id });
  }
  return headings;
}

/** Character count used for progress bookkeeping. Mirrors what the browser sees in text nodes. */
export function textLength(nodes) {
  let n = 0;
  for (const node of nodes) n += textContent(node).length;
  return n;
}

/** An empty span that keeps an id where its element no longer is, as a target for links. */
export function anchorSpan(id) {
  return { type: ElementType.Tag, name: 'span', attribs: { id, class: 'anchor' }, children: [], parent: null };
}

/**
 * Where to cut a run of `total` text characters into the fewest parts that fit in `budget`, of about equal
 * size, so no small part is left over. `places` are where a cut may go, in order, as { at, pos, rank }:
 * `pos` is the text before the place and `rank` how good a place it is, 1 the best. Each cut goes at the
 * best place within a quarter of a part of its ideal point, the nearest of those equally good. A cut never
 * makes a part larger than the budget, nor leaves more text than the parts after it can hold; when no place
 * near the ideal point keeps to that, the nearest place that does is taken, and when none does (one huge
 * block), the nearest place of all, so a part may run over the budget. Returns the chosen places' `at`.
 */
export function chooseCuts(places, total, budget) {
  if (!(total > budget)) return [];
  const count = Math.ceil(total / budget);
  const part = total / count;
  const cuts = [];
  let prev = 0;
  let from = 0;
  for (let j = 1; j < count; j++) {
    const ideal = j * part;
    let best = null;
    let fitting = null;
    let nearest = null;
    for (let i = from; i < places.length; i++) {
      const place = places[i];
      // Every part holds some text.
      if (place.pos <= prev || place.pos >= total) continue;
      const d = Math.abs(place.pos - ideal);
      if (!nearest || d < nearest.d) nearest = { i, d };
      if (place.pos - prev > budget || total - place.pos > (count - j) * budget) continue;
      if (!fitting || d < fitting.d) fitting = { i, d };
      if (d <= part / 4 && (!best || place.rank < best.rank || (place.rank === best.rank && d < best.d))) best = { i, d, rank: place.rank };
    }
    const pick = best || fitting || nearest;
    if (!pick) break;
    cuts.push(places[pick.i].at);
    prev = places[pick.i].pos;
    from = pick.i + 1;
  }
  return cuts;
}

const isBlank = (node) => isText(node) && !node.data.trim();
// An empty element with an id marks a place for links, so it stays with what follows it.
const isAnchor = (node) => isTag(node) && INLINE_TAGS.has(node.name) && !!node.attribs.id && !textContent(node).trim() && !findOne((e) => e.name === 'img', node.children, true);

/** The first or last child that is more than white space or an anchor. */
function edgeChild(node, last) {
  const kids = node.children.filter((c) => !isBlank(c) && !isAnchor(c));
  return last ? kids[kids.length - 1] : kids[0];
}

/** Does the node begin with a heading, itself or as the first thing in a wrapper? */
function startsWithHeading(node) {
  for (let n = node; n && isTag(n); n = WRAPPER_TAGS.has(n.name) ? edgeChild(n, false) : null) if (HEADING_RE.test(n.name)) return true;
  return false;
}

/** Does the node end with an element of this kind, itself or as the last thing in a wrapper? */
function endsWith(node, test) {
  for (let n = node; n && isTag(n); n = WRAPPER_TAGS.has(n.name) ? edgeChild(n, true) : null) if (test(n.name)) return true;
  return false;
}

/**
 * Split the root's children into chunks that fit in `budget` text characters. A chapter that fits stays
 * whole; a longer one is cut into the fewest parts of about equal size (see chooseCuts), best before a
 * heading, then after a rule such as a scene break, then between any two blocks. A cut goes only before a
 * block-level element, never right after a heading, so a heading stays with what follows it. Wrapper
 * elements larger than the budget are unwrapped so a cut can go inside them, their id kept as an anchor.
 * Returns arrays of nodes.
 */
export function chunkNodes(root, budget) {
  const total = textLength(root.children);
  if (!(total > budget)) {
    const whole = [...root.children];
    for (const n of whole) n.parent = null;
    return [whole];
  }
  const nodes = [];
  const flatten = (list) => {
    for (const node of list) {
      if (isTag(node) && WRAPPER_TAGS.has(node.name) && textContent(node).length > budget && node.children.some((c) => isTag(c) && BLOCK_TAGS.has(c.name))) {
        if (node.attribs.id) nodes.push(anchorSpan(node.attribs.id));
        if (node.attribs.style && /text-align/.test(node.attribs.style)) {
          for (const c of node.children) if (isTag(c) && !c.attribs.style) c.attribs.style = node.attribs.style;
        }
        flatten(node.children);
      } else nodes.push(node);
    }
  };
  flatten(root.children);

  const isHeading = (name) => HEADING_RE.test(name);
  const places = [];
  let pos = 0;
  let last = null; // the last node with content, past white space and anchors
  let anchors = null; // where the anchors just before this node begin: { at, pos }
  nodes.forEach((node, i) => {
    const len = textContent(node).length;
    if (isBlank(node) || isAnchor(node)) {
      if (!anchors && isAnchor(node)) anchors = { at: i, pos };
      pos += len;
      return;
    }
    if (last && isTag(node) && !INLINE_TAGS.has(node.name) && !endsWith(last, isHeading)) {
      const rank = startsWithHeading(node) ? 1 : endsWith(last, (name) => name === 'hr') ? 2 : 3;
      places.push(anchors ? { ...anchors, rank } : { at: i, pos, rank });
    }
    last = node;
    anchors = null;
    pos += len;
  });

  const chunks = [];
  let start = 0;
  for (const at of [...chooseCuts(places, total, budget), nodes.length]) {
    chunks.push(nodes.slice(start, at));
    start = at;
  }
  // Detach nodes from their previous parents to avoid serialising stale structure.
  for (const chunk of chunks) for (const n of chunk) n.parent = null;
  return chunks;
}

export function serialize(nodes) {
  return render(nodes, { encodeEntities: 'utf8', selfClosingTags: true, emptyAttrs: true });
}

export { textContent, getElementsByTagName, isTag, isText };
