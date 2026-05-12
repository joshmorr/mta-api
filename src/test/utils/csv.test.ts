import { describe, expect, it } from 'bun:test';
import { parseCSV, forEachCSVRow } from '../../utils/csv';

describe('parseCSV', () => {
  it('parses a simple CSV with headers and one row', () => {
    const input = 'id,name,value\n1,foo,bar';
    expect(parseCSV(input)).toEqual([{ id: '1', name: 'foo', value: 'bar' }]);
  });

  it('parses multiple rows', () => {
    const input = 'a,b\n1,2\n3,4';
    expect(parseCSV(input)).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('returns empty array for header-only input', () => {
    expect(parseCSV('id,name')).toEqual([]);
  });

  it('returns empty array for completely empty input', () => {
    expect(parseCSV('')).toEqual([]);
  });

  it('handles Windows-style CRLF line endings', () => {
    const input = 'id,name\r\n1,foo\r\n2,bar\r\n';
    expect(parseCSV(input)).toEqual([
      { id: '1', name: 'foo' },
      { id: '2', name: 'bar' },
    ]);
  });

  it('handles quoted fields', () => {
    const input = 'id,name\n1,"hello, world"';
    expect(parseCSV(input)).toEqual([{ id: '1', name: 'hello, world' }]);
  });

  it('handles escaped double quotes inside quoted fields', () => {
    const input = 'id,name\n1,"say ""hi"""';
    expect(parseCSV(input)).toEqual([{ id: '1', name: 'say "hi"' }]);
  });

  it('trims whitespace from unquoted fields', () => {
    const input = 'id , name \n 1 , foo ';
    expect(parseCSV(input)).toEqual([{ id: '1', name: 'foo' }]);
  });

  it('fills missing trailing columns with empty string', () => {
    const input = 'a,b,c\n1,2';
    const result = parseCSV(input);
    expect(result[0].c).toBe('');
  });

  it('skips blank lines between rows', () => {
    const input = 'id,name\n1,foo\n\n2,bar';
    expect(parseCSV(input)).toEqual([
      { id: '1', name: 'foo' },
      { id: '2', name: 'bar' },
    ]);
  });

  it('handles a real-world GTFS stops header row', () => {
    const input =
      'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
      '101,Times Sq-42 St,40.755477,-73.987691,1,\n' +
      '101N,Times Sq-42 St,40.755477,-73.987691,0,101';
    const result = parseCSV(input);
    expect(result).toHaveLength(2);
    expect(result[0].stop_id).toBe('101');
    expect(result[1].parent_station).toBe('101');
  });
});

describe('forEachCSVRow', () => {
  it('invokes the callback once per data row and returns the count', () => {
    const rows: Record<string, string>[] = [];
    const count = forEachCSVRow('a,b\n1,2\n3,4\n5,6', (row) => rows.push(row));
    expect(count).toBe(3);
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
      { a: '5', b: '6' },
    ]);
  });

  it('returns 0 for header-only input and never calls the callback', () => {
    let calls = 0;
    const count = forEachCSVRow('id,name', () => calls++);
    expect(count).toBe(0);
    expect(calls).toBe(0);
  });

  it('fills missing trailing columns with empty string (matches parseCSV)', () => {
    const rows: Record<string, string>[] = [];
    forEachCSVRow('a,b,c\n1,2', (row) => rows.push(row));
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('skips blank lines between rows', () => {
    const rows: Record<string, string>[] = [];
    const count = forEachCSVRow('a,b\n1,2\n\n3,4', (row) => rows.push(row));
    expect(count).toBe(2);
    expect(rows[1]).toEqual({ a: '3', b: '4' });
  });

  it('handles CRLF line endings', () => {
    const rows: Record<string, string>[] = [];
    forEachCSVRow('a,b\r\n1,2\r\n', (row) => rows.push(row));
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });
});
