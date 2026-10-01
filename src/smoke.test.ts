import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('package entry point', () => {
  it('loads', () => {
    expect(api).toBeDefined();
  });
});
