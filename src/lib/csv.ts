/** Parser CSV mínimo: aspas, delimitador `,` ou `;` (auto), cabeçalho obrigatório. */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);

  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? '').trim()));
    return o;
  });
}
