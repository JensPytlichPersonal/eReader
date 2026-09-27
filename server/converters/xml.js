// Tiny helpers over htmlparser2 for namespace-agnostic XML access.
import { parseDocument, DomUtils } from 'htmlparser2';

export function parseXml(text) {
  return parseDocument(text, { xmlMode: true, decodeEntities: true });
}

export function localName(el) {
  const n = el.name || '';
  const i = n.indexOf(':');
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase();
}

export function findAllLocal(root, name, recurse = true) {
  return DomUtils.findAll((e) => localName(e) === name, root.children ?? root, recurse);
}

export function findFirstLocal(root, name) {
  return DomUtils.findOne((e) => localName(e) === name, root.children ?? root, true);
}

export function attr(el, name) {
  if (!el || !el.attribs) return undefined;
  if (el.attribs[name] != null) return el.attribs[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(el.attribs)) {
    const kl = k.toLowerCase();
    if (kl === lower || kl.endsWith(`:${lower}`)) return v;
  }
  return undefined;
}

export function text(el) {
  return el ? DomUtils.textContent(el).replace(/\s+/g, ' ').trim() : '';
}

export function children(el) {
  return (el?.children || []).filter((c) => c.type === 'tag');
}
