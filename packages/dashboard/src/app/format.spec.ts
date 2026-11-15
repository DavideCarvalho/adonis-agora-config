import { describe, expect, it } from 'vitest';
import { editorText, parseEditorText, preview, relativeTime } from './format';

describe('format', () => {
  it('shortens a value for a table cell', () => {
    expect(preview('short')).toBe('short');
    expect(preview({ a: 1 })).toBe('{"a":1}');
    expect(preview('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('reads the editor text like the CLI reads a value', () => {
    expect(parseEditorText('true')).toBe(true);
    expect(parseEditorText('3000')).toBe(3000);
    expect(parseEditorText('{"a":1}')).toEqual({ a: 1 });
    expect(parseEditorText('plain text')).toBe('plain text');
    expect(parseEditorText('   ')).toBeUndefined();
    expect(editorText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(editorText('x')).toBe('x');
  });

  it('renders a relative time', () => {
    expect(relativeTime(new Date().toISOString())).toBe('just now');
    expect(relativeTime(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3d ago');
  });
});
