import { Marked } from 'marked';
import { normalizeDocument } from './html.js';
import { assembleSections, titleFromFilename } from './bundle.js';
import { decodeText } from './text.js';

/** Strip a YAML front matter block and pull title/author from it when present. */
function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { body: text, meta: {} };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/);
    if (mm) meta[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { body: text.slice(m[0].length), meta };
}

export function slugify(text) {
  return text.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

function createMarked() {
  const marked = new Marked({ gfm: true, breaks: false });
  const seen = new Map();
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        let slug = slugify(text) || 'section';
        const n = seen.get(slug) || 0;
        seen.set(slug, n + 1);
        if (n) slug = `${slug}-${n}`;
        return `<h${depth} id="${slug}">${text}</h${depth}>\n`;
      },
    },
  });
  return marked;
}

export async function convertMarkdown(buffer, { filename }) {
  const text = decodeText(buffer);
  const { body, meta } = frontMatter(text);
  const html = createMarked().parse(body);
  const { root } = normalizeDocument(`<body>${html}</body>`, {
    resolveImage: () => null, // a single .md upload carries no image files
    resolveLink: (href) => (href.startsWith('#') ? `md${href}` : null),
  });
  const { sections, toc } = assembleSections([{ root, key: 'md' }]);
  let title = meta.title;
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    title = h1 ? h1[1].trim() : titleFromFilename(filename);
  }
  return { meta: { title, author: meta.author || '', language: meta.lang || meta.language || '', format: 'md' }, sections, toc };
}
