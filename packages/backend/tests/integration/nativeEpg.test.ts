/**
 * Native EPG is an existing catalog/meta/stream contract, not a new resource.
 * Source of truth: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/epg.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  DEBUG: false,
  CACHE_ENABLED: true,
  CACHE_TTL_MS: 21600000,
  MAX_CACHE_ENTRIES: 10,
  IPTV_ORG_CACHE_TTL_MS: 21600000,
  M3U_CACHE_TTL_MS: 21600000,
  DATA_MEMORY_TTL_MS: 300000,
  UPDATE_INTERVAL_MS: 14400000,
  MIN_UPDATE_INTERVAL_MS: 1800000,
  CATALOG_PAGE_SIZE: 100,
  ADDON_NAME: 'TestAddon',
  ADDON_DESCRIPTION: 'Test description',
  ADDON_LOGO_URL: '',
  ADDON_BACKGROUND_URL: '',
  SQLITE_PATH: null,
}));

const mockM3uFetch = vi.hoisted(() => vi.fn());
const mockCache = vi.hoisted(() => new Map<string, any>());

vi.mock('../../src/config/env', () => ({ default: mockEnv, repoRoot: '/tmp' }));
vi.mock('../../src/utils/sqliteCache', () => ({
  init: vi.fn(),
  get: vi.fn((key: string) => mockCache.get(key) ?? null),
  set: vi.fn((key: string, value: any) => mockCache.set(key, value)),
  getRaw: vi.fn((key: string) => mockCache.get(key) ?? null),
  setRaw: vi.fn((key: string, value: any) => mockCache.set(key, value)),
  del: vi.fn((key: string) => mockCache.delete(key)),
}));
vi.mock('../../src/utils/logger', () => ({
  makeLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/providers/m3uProvider', () => ({ fetchData: mockM3uFetch }));
vi.mock('../../src/providers/xtreamProvider', () => ({ fetchData: vi.fn() }));
vi.mock('../../src/providers/iptvOrgProvider', () => ({ fetchData: vi.fn() }));

import createAddon from '../../src/addon/builder';

describe('native EPG catalog handler', () => {
  beforeEach(() => {
    mockCache.clear();
    mockM3uFetch.mockReset();
    mockM3uFetch.mockImplementation(async (addon: any) => {
      addon.channels = [{
        id: 'm3guide_news',
        name: 'Guide News',
        type: 'tv',
        url: 'https://example.com/news.m3u8',
        logo: '',
        category: 'News',
        attributes: { 'tvg-id': 'guide.news' },
      }];
      addon.epgData = {
        'guide.news': [{
          start: Date.parse('2026-09-12T18:00:00.000Z'),
          stop: Date.parse('2026-09-12T18:45:00.000Z'),
          title: 'Evening News',
          desc: 'The day\'s headlines.',
        }],
      };
      addon.lastEpgUpdate = Date.now();
    });
  });

  it('advertises EPG and returns a dated catalog as metasDetailed', async () => {
    const iface: any = await createAddon({
      provider: 'm3u',
      m3uUrl: 'https://example.com/playlist.m3u',
      enableEpg: true,
    });

    expect(iface.manifest.behaviorHints.epgProvider).toBe(true);
    expect(iface.manifest.catalogs[0].extra).toContainEqual({ name: 'date', isRequired: false });

    // AddonInterface.get is positional: (resource, type, id, extra, config).
    const response = await iface.get('catalog', 'tv', 'iptv_channels', {
      date: '2026-09-12',
    });

    expect(response.metasDetailed).toHaveLength(1);
    expect(response.metasDetailed[0]).toMatchObject({
      id: 'm3guide_news',
      behaviorHints: { isLive: true, hasScheduledVideos: true },
      videos: [{
        id: 'm3guide_news:epg:2026-09-12T18:00:00.000Z',
        title: 'Evening News',
        overview: 'The day\'s headlines.',
        released: '2026-09-12T18:00:00.000Z',
        startTime: '2026-09-12T18:00:00.000Z',
        endTime: '2026-09-12T18:45:00.000Z',
      }],
    });
  });

  it('rehydrates persisted EPG before generating dated catalog rows after memory eviction', async () => {
    const iface: any = await createAddon({
      provider: 'm3u',
      m3uUrl: 'https://example.com/evicted-playlist.m3u',
      enableEpg: true,
    });

    expect(iface.addonInstance.channels).toEqual([]);
    expect(iface.addonInstance.epgData).toEqual({});

    const response = await iface.get('catalog', 'tv', 'iptv_channels', {
      date: '2026-09-12',
    });

    expect(response.metasDetailed).toHaveLength(1);
    expect(response.metasDetailed[0].videos[0].title).toBe('Evening News');
  });

  it('forces an EPG download when bootstrap refresh deletes the persisted guide', async () => {
    const epgUpdateTimesAtFetch: Array<number | null> = [];
    mockM3uFetch.mockImplementation(async (addon: any) => {
      epgUpdateTimesAtFetch.push(addon.lastEpgUpdate);
      addon.channels = [{
        id: 'm3guide_news',
        name: 'Guide News',
        type: 'tv',
        url: 'https://example.com/news.m3u8',
        logo: '',
        category: 'News',
        attributes: { 'tvg-id': 'guide.news' },
      }];
      if (!addon.lastEpgUpdate) {
        addon.epgData = {
          'guide.news': [{
            start: Date.parse('2026-09-12T18:00:00.000Z'),
            stop: Date.parse('2026-09-12T18:45:00.000Z'),
            title: 'Refreshed Evening News',
            desc: '',
          }],
        };
        addon.lastEpgUpdate = Date.now();
      }
    });

    const iface: any = await createAddon({
      provider: 'm3u',
      m3uUrl: 'https://example.com/bootstrap-refresh-playlist.m3u',
      enableEpg: true,
    });
    const addon = iface.addonInstance;
    addon.lastUpdate = 0;
    addon.lastEpgUpdate = Date.now();

    await addon.refreshOnFirstCatalogRequest();

    expect(epgUpdateTimesAtFetch.at(-1)).toBeNull();
    expect(addon.epgData['guide.news'][0].title).toBe('Refreshed Evening News');
  });
});
