/**
 * Every seeder stamps `createdAt`/`updatedAt` on the rows it seeds: an absent or blank timestamp is
 * `now`, an authored one is kept. Rust twin: `orbital-core` `runtime/seed.rs` `instance_rows`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPersistence, MockPersistenceAdapter, stampSeedTimestamps } from '../src/mock/index.js';

const NOW = '2026-10-13T08:30:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe('stampSeedTimestamps', () => {
  it('stamps both timestamps on a row that has neither', () => {
    expect(stampSeedTimestamps({ id: 'a' }, NOW)).toEqual({ id: 'a', createdAt: NOW, updatedAt: NOW });
  });

  it('treats an empty string as absent', () => {
    expect(stampSeedTimestamps({ id: 'a', createdAt: '', updatedAt: '' }, NOW)).toEqual({ id: 'a', createdAt: NOW, updatedAt: NOW });
  });

  it('control: keeps an authored timestamp and stamps only the missing one', () => {
    expect(stampSeedTimestamps({ id: 'a', createdAt: '2020-01-01T00:00:00.000Z' }, NOW)).toEqual({
      id: 'a',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: NOW,
    });
  });
});

describe('InMemoryPersistence.seed', () => {
  it('stamps seeded rows', async () => {
    const store = new InMemoryPersistence();
    store.seed({ Item: [{ id: 'a', kind: 'x' }] });
    expect(await store.getById('Item', 'a')).toEqual({ id: 'a', kind: 'x', createdAt: NOW, updatedAt: NOW });
  });

  it('control: keeps authored timestamps', async () => {
    const store = new InMemoryPersistence();
    store.seed({ Item: [{ id: 'a', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z' }] });
    expect(await store.getById('Item', 'a')).toEqual({ id: 'a', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z' });
  });
});

describe('MockPersistenceAdapter authored instances', () => {
  const entity = (instances: Array<Record<string, string>>) => ({
    name: 'Item',
    fields: [{ name: 'id', type: 'string' as const }],
    seedData: instances,
  });

  it('stamps rows with the dispatch-time now, not a fixed reference date', async () => {
    const store = new MockPersistenceAdapter({ seed: 1 });
    store.registerEntity(entity([{ id: 'a' }]));
    expect(await store.getById('Item', 'a')).toMatchObject({ id: 'a', createdAt: NOW, updatedAt: NOW });
  });

  it('control: keeps authored timestamps', async () => {
    const store = new MockPersistenceAdapter({ seed: 1 });
    store.registerEntity(entity([{ id: 'a', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z' }]));
    expect(await store.getById('Item', 'a')).toMatchObject({ createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z' });
  });
});
