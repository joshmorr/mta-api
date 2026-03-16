import type { TranslatedString } from '../types/gtfs';

export function toNumber(val: number | { toNumber(): number } | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'object') return val.toNumber();
  return val;
}

export function getEnglishText(ts: TranslatedString | undefined): string {
  if (!ts) return '';
  const en = ts.translation.find((t) => t.language === 'en' || !t.language);
  return en?.text ?? '';
}
