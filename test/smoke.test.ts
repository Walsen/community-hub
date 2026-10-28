import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/shared/index.js';

describe('project scaffold', () => {
  it('exposes the package name', () => {
    expect(PACKAGE_NAME).toBe('community-hub');
  });
});
