export function parseCSV(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  forEachCSVRow(text, (row) => { rows.push(row); });
  return rows;
}

/**
 * Iterate over CSV rows one at a time, calling `cb` for each.
 * Avoids building a full array — useful for large files where the
 * caller can process (e.g. batch-insert) and discard each row.
 */
export function forEachCSVRow(
  text: string,
  cb: (row: Record<string, string>) => void,
): number {
  let pos = 0;
  let count = 0;

  // Find first newline to extract header
  const firstNl = text.indexOf('\n', pos);
  if (firstNl === -1) return 0;
  const headers = splitCSVLine(text.slice(pos, firstNl).replace(/\r/, '')).map(normalizeCSVCell);
  pos = firstNl + 1;

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end).replace(/\r/, '');
    pos = end + 1;
    if (!line) continue;
    const vals = splitCSVLine(line).map(normalizeCSVCell);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] ?? '';
    }
    cb(row);
    count++;
  }
  return count;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function normalizeCSVCell(value: string): string {
  return value.trim();
}
