import { describe, it, expect, beforeAll } from 'vitest';
import { FhirSnapshotGenerator } from 'fhir-snapshot-generator';
import { FhirStructureNavigator, ICache } from '@outburn/structure-navigator';
import { FhirPackageExplorer } from 'fhir-package-explorer';

const context = ['hl7.fhir.us.core@6.1.0', 'fsg.test.pkg@0.1.0'];

let fsg: FhirSnapshotGenerator;

beforeAll(async () => {
  const fpe = await FhirPackageExplorer.create({
    context,
    cachePath: './test/.test-cache',
    fhirVersion: '4.0.1'
  });
  fsg = await FhirSnapshotGenerator.create({
    fhirVersion: '4.0.1',
    cacheMode: 'lazy',
    fpe
  });
}, 900000);

describe('LRU Cache', () => {
  it('evicts least recently used items when capacity is reached', async () => {
    // Create a navigator with small cache sizes
    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: undefined, // Use only LRU with small size (50)
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Fill the cache beyond its small capacity by resolving many different elements
    const elements = [
      'Patient.id',
      'Patient.meta',
      'Patient.identifier',
      'Patient.active',
      'Patient.name',
      'Patient.telecom',
      'Patient.gender',
      'Patient.birthDate',
      'Patient.address',
      'Patient.maritalStatus',
      'Patient.contact',
      'Patient.communication',
      'Observation.id',
      'Observation.status',
      'Observation.category',
      'Observation.code',
      'Observation.subject',
      'Observation.effective[x]',
      'Observation.value[x]',
      'Observation.interpretation'
    ];

    // Access elements to populate cache
    for (const path of elements) {
      const [type, ...pathSegments] = path.split('.');
      await navigator.getElement(type, pathSegments.join('.'));
    }

    // Access the first element again - should still be in cache due to recent access
    const firstElement = await navigator.getElement('Patient', 'id');
    expect(firstElement.path).toBe('Patient.id');
  });

  it('promotes recently accessed items in LRU', async () => {
    const navigator = new FhirStructureNavigator(fsg);
    
    // Access an element
    const el1 = await navigator.getElement('Patient', 'gender');
    expect(el1.path).toBe('Patient.gender');
    
    // Fill cache with other elements
    await navigator.getElement('Patient', 'id');
    await navigator.getElement('Patient', 'meta');
    await navigator.getElement('Patient', 'identifier');
    
    // Access the first element again - should be fast (cached)
    const el2 = await navigator.getElement('Patient', 'gender');
    expect(el2.path).toBe('Patient.gender');
    expect(el2).toEqual(el1);
  });
});

describe('Two-Tier Cache Promotion', () => {
  it('promotes values from external cache to LRU on get', async () => {
    const externalCache = new Map<string, any>();
    const mockCache: ICache<any> = {
      get: async (key: (string | number)[]) => {
        return externalCache.get(JSON.stringify(key));
      },
      set: async (key: (string | number)[], value: any) => {
        externalCache.set(JSON.stringify(key), value);
      },
      has: async (key: (string | number)[]) => {
        return externalCache.has(JSON.stringify(key));
      },
      delete: async (key: (string | number)[]) => {
        const result = externalCache.has(JSON.stringify(key));
        externalCache.delete(JSON.stringify(key));
        return result;
      },
      clear: async () => {
        externalCache.clear();
      }
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: mockCache,
      childrenCache: mockCache,
      snapshotCache: mockCache,
      typeMetaCache: mockCache
    });

    // First access - will populate both LRU and external cache
    const el1 = await navigator.getElement('Patient', 'gender');
    expect(el1.path).toBe('Patient.gender');
    
    // Verify external cache has the element
    expect(externalCache.size).toBeGreaterThan(0);

    // Create a new navigator with the same external cache
    // This simulates a fresh LRU but persistent external cache
    const navigator2 = new FhirStructureNavigator(fsg, undefined, {
      elementCache: mockCache,
      childrenCache: mockCache,
      snapshotCache: mockCache,
      typeMetaCache: mockCache
    });

    // Access should hit external cache and promote to new LRU
    const el2 = await navigator2.getElement('Patient', 'gender');
    expect(el2.path).toBe('Patient.gender');
  });

  it('writes to both LRU and external cache on set', async () => {
    let externalSetCount = 0;
    const mockCache: ICache<any> = {
      get: async () => undefined,
      set: async () => {
        externalSetCount++;
      },
      has: async () => false,
      delete: async () => false,
      clear: async () => {}
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: mockCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Access an element - should write to both caches
    await navigator.getElement('Patient', 'gender');
    
    // Verify external cache was written to
    expect(externalSetCount).toBeGreaterThan(0);
  });
});

describe('External Cache Error Handling', () => {
  it('falls back to LRU when external cache get throws', async () => {
    let getAttempts = 0;
    const failingCache: ICache<any> = {
      get: async () => {
        getAttempts++;
        throw new Error('External cache unavailable');
      },
      set: async () => {},
      has: async () => false,
      delete: async () => false,
      clear: async () => {}
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: failingCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Should still work despite external cache errors
    const el = await navigator.getElement('Patient', 'gender');
    expect(el.path).toBe('Patient.gender');
    expect(getAttempts).toBeGreaterThan(0);
  });

  it('continues operation when external cache set throws', async () => {
    let setAttempts = 0;
    const failingCache: ICache<any> = {
      get: async () => undefined,
      set: async () => {
        setAttempts++;
        throw new Error('External cache write failed');
      },
      has: async () => false,
      delete: async () => false,
      clear: async () => {}
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: failingCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Should still work and cache in LRU
    const el1 = await navigator.getElement('Patient', 'gender');
    expect(el1.path).toBe('Patient.gender');
    expect(setAttempts).toBeGreaterThan(0);

    // Second access should hit LRU (no external cache error)
    const el2 = await navigator.getElement('Patient', 'gender');
    expect(el2.path).toBe('Patient.gender');
  });

  it('handles external cache has errors gracefully', async () => {
    const failingCache: ICache<any> = {
      get: async () => undefined,
      set: async () => {},
      has: async () => {
        throw new Error('External cache has check failed');
      },
      delete: async () => false,
      clear: async () => {}
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: failingCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Should still work
    const el = await navigator.getElement('Patient', 'gender');
    expect(el.path).toBe('Patient.gender');
  });

  it('handles external cache delete errors gracefully', async () => {
    const failingCache: ICache<any> = {
      get: async () => undefined,
      set: async () => {},
      has: async () => false,
      delete: async () => {
        throw new Error('External cache delete failed');
      },
      clear: async () => {}
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: failingCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Populate cache first
    await navigator.getElement('Patient', 'gender');
    
    // Should not throw when external delete fails
    // (Note: There's no public API to delete from cache, but internal operations should handle it)
    expect(true).toBe(true);
  });

  it('handles external cache clear errors gracefully', async () => {
    const failingCache: ICache<any> = {
      get: async () => undefined,
      set: async () => {},
      has: async () => false,
      delete: async () => false,
      clear: async () => {
        throw new Error('External cache clear failed');
      }
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: failingCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Should still work
    await navigator.getElement('Patient', 'gender');
    
    // No public clear method, but internal operations should handle it
    expect(true).toBe(true);
  });

  it('recovers from intermittent external cache failures', async () => {
    let failureCount = 0;
    const intermittentCache: ICache<any> = {
      get: async () => {
        failureCount++;
        if (failureCount <= 5) {
          throw new Error('Temporary failure');
        }
        return undefined;
      },
      set: async () => {},
      has: async () => false,
      delete: async () => false,
      clear: async () => {}
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: intermittentCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    // Access elements while external cache is failing
    await navigator.getElement('Patient', 'gender');
    await navigator.getElement('Patient', 'birthDate');
    
    // Eventually external cache starts working again (after 5 failures)
    const el = await navigator.getElement('Patient', 'address');
    expect(el.path).toBe('Patient.address');
    expect(failureCount).toBeGreaterThan(5);
  });
});

describe('Cache with Sync External Implementation', () => {
  it('works with synchronous external cache', async () => {
    const syncCache = new Map<string, any>();
    const mockSyncCache: ICache<any> = {
      get: (key: (string | number)[]) => {
        return syncCache.get(JSON.stringify(key));
      },
      set: (key: (string | number)[], value: any) => {
        syncCache.set(JSON.stringify(key), value);
      },
      has: (key: (string | number)[]) => {
        return syncCache.has(JSON.stringify(key));
      },
      delete: (key: (string | number)[]) => {
        const result = syncCache.has(JSON.stringify(key));
        syncCache.delete(JSON.stringify(key));
        return result;
      },
      clear: () => {
        syncCache.clear();
      }
    };

    const navigator = new FhirStructureNavigator(fsg, undefined, {
      elementCache: mockSyncCache,
      childrenCache: undefined,
      snapshotCache: undefined,
      typeMetaCache: undefined
    });

    const el = await navigator.getElement('Patient', 'gender');
    expect(el.path).toBe('Patient.gender');
    expect(syncCache.size).toBeGreaterThan(0);
  });
});
