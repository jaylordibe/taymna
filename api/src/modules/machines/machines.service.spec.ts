import { describe, expect, it } from 'vitest';
import { splitCredential } from './machines.service.js';

describe('splitCredential', () => {
  it('splits a well-formed "<id>.<secret>" credential', () => {
    expect(splitCredential('abc123.super-secret')).toEqual(['abc123', 'super-secret']);
  });

  it('splits on the first dot only, so secrets may contain dots', () => {
    expect(splitCredential('abc123.part.two')).toEqual(['abc123', 'part.two']);
  });

  it('rejects a value with no dot', () => {
    expect(splitCredential('no-dot-here')).toEqual([null, null]);
  });

  it('rejects a value with an empty id', () => {
    expect(splitCredential('.secret')).toEqual([null, null]);
  });

  it('rejects a value with an empty secret', () => {
    expect(splitCredential('id.')).toEqual([null, null]);
  });
});
