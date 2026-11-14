import { expect, test } from 'vitest';
import { total } from './pricing.js';

test('no discount under 20', () => expect(total(10, 2)).toBe(20));
test('discount from 20 units', () => expect(total(20, 2)).toBe(36));
