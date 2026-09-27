// Re-converts every book (or the ids given as arguments) with the current converters.
import { createApp } from '../app.js';

const { db, processor } = createApp({ quiet: false });
const ids = process.argv.slice(2);
const rows = ids.length ? ids.map((id) => ({ id })) : db.prepare('SELECT id FROM books ORDER BY added_at').all();
console.log(`Reprocessing ${rows.length} book(s)...`);
for (const row of rows) processor.enqueue(row.id);
const wait = () => { if (processor.isBusy()) setTimeout(wait, 200); else { console.log('Done.'); process.exit(0); } };
wait();
