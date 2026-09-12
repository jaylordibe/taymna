import { describe, expect, it } from 'vitest';
import { sanitizeAgentVersion, splitCredential } from './machines.service.js';

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

describe('sanitizeAgentVersion', () => {
  it('accepts the version shapes the agent actually reports', () => {
    expect(sanitizeAgentVersion('0.2.0')).toBe('0.2.0');
    expect(sanitizeAgentVersion('0.0.0-dev')).toBe('0.0.0-dev');
    expect(sanitizeAgentVersion('1.0.0-rc.1+build.7')).toBe('1.0.0-rc.1+build.7');
    expect(sanitizeAgentVersion(' 0.2.0 ')).toBe('0.2.0');
  });

  it('drops anything an agent too old to report sends', () => {
    expect(sanitizeAgentVersion(undefined)).toBeNull();
    expect(sanitizeAgentVersion(null)).toBeNull();
    expect(sanitizeAgentVersion('')).toBeNull();
    expect(sanitizeAgentVersion('   ')).toBeNull();
  });

  it('drops anything that is not a string, whatever the machine sends', () => {
    expect(sanitizeAgentVersion(42)).toBeNull();
    expect(sanitizeAgentVersion({ version: '0.2.0' })).toBeNull();
    expect(sanitizeAgentVersion(['0.2.0'])).toBeNull();
    expect(sanitizeAgentVersion(true)).toBeNull();
  });

  it('refuses text that is not version-shaped rather than storing part of it', () => {
    expect(sanitizeAgentVersion('<script>alert(1)</script>')).toBeNull();
    expect(sanitizeAgentVersion('0.2.0; DROP TABLE machines')).toBeNull();
    expect(sanitizeAgentVersion('../../etc/passwd')).toBeNull();
    expect(sanitizeAgentVersion('0.2.0\n0.3.0')).toBeNull();
    expect(sanitizeAgentVersion('-leading-dash')).toBeNull();
  });

  it('refuses an over-long value instead of truncating it to fit the column', () => {
    expect(sanitizeAgentVersion('0'.repeat(32))).toBe('0'.repeat(32));
    expect(sanitizeAgentVersion('0'.repeat(33))).toBeNull();
  });
});
