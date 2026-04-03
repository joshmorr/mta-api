import Papa, { type ParseConfig } from 'papaparse';

const BASE_OPTIONS: ParseConfig<Record<string, string>> = {
  header: true,
  skipEmptyLines: true,
  transformHeader: (h) => h.trim(),
  transform: (v) => v.trim(),
};

export function parseCSV(text: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, string>>(text, BASE_OPTIONS);
  const fields = result.meta.fields ?? [];
  return result.data.map((row) =>
    Object.fromEntries(fields.map((f) => [f, row[f] ?? ''])),
  );
}

export function forEachCSVRow(
  text: string,
  cb: (row: Record<string, string>) => void,
): number {
  let count = 0;
  Papa.parse<Record<string, string>>(text, {
    ...BASE_OPTIONS,
    step: (result) => {
      const fields = result.meta.fields ?? [];
      const row = Object.fromEntries(fields.map((f) => [f, result.data[f] ?? '']));
      cb(row);
      count++;
    },
  });
  return count;
}
