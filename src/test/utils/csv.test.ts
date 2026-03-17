import { describe, expect, it } from 'bun:test';
import { parseCSV } from '../../utils/csv';

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
