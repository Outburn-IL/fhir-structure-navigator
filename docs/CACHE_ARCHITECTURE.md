# Cache Architecture

The FhirStructureNavigator implements a sophisticated two-tier caching strategy designed for high performance and flexibility.

## Overview

The navigator maintains four independent cache types:
1. **Snapshot Cache** - Stores enriched FHIR StructureDefinition snapshots
2. **Type Meta Cache** - Stores metadata about FHIR types (kind, resourceType, etc.)
3. **Element Cache** - Stores resolved ElementDefinitions by path
4. **Children Cache** - Stores arrays of child elements

Each cache consists of two layers:
- **Inner LRU Layer**: Fast in-memory cache for ultra-hot entries
- **External Layer** (optional): Pluggable persistent cache (e.g., LMDB)

## Cache Key Design

All cache keys use **array-based keys** instead of concatenated strings. This design:
- Eliminates string concatenation/parsing overhead
- Enables efficient range queries in LMDB
- Provides natural key structure for database indexing

### Key Formats

#### Snapshot Cache
```typescript
[normalizedSnapshotId: string, packageId: string, packageVersion: string]
```
Examples:
- String ID: `["Patient", "hl7.fhir.r4.core", "4.0.1"]`
- FileIndexEntryWithPkg: `["hl7.fhir.r4.core::4.0.1::StructureDefinition-patient.json", "", ""]`

#### Type Meta Cache
```typescript
[typeCode: string, corePackageId: string, corePackageVersion: string]
```
Example: `["Quantity", "hl7.fhir.r4.core", "4.0.1"]`

#### Element Cache (with package context)
```typescript
[packageContextOrFilter: string, normalizedSnapshotId: string, pathSegments: string]
```
Examples:
- String ID: `['[{"id":"hl7.fhir.r4.core","version":"4.0.1"}]', "Patient", "identifier.system"]`
- FileIndexEntryWithPkg: `['[{"id":"hl7.fhir.us.core","version":"6.1.0"}]', "hl7.fhir.us.core::6.1.0::StructureDefinition-us-core-patient.json", "identifier.system"]`
- With packageFilter: `['[{"id":"hl7.fhir.r4.core","version":"4.0.1"}]', "Patient", "identifier.system"]`

**Note**: If a `packageFilter` is provided to the resolution methods, it overrides the general `packageContext` for cache key generation.

#### Children Cache (with package context)
```typescript
[packageContext: string, normalizedSnapshotId: string, fshPath: string]
```
Examples:
- String ID: `['[{"id":"hl7.fhir.r4.core","version":"4.0.1"}]', "Patient", "identifier"]`
- FileIndexEntryWithPkg: `['[{"id":"hl7.fhir.us.core","version":"6.1.0"}]', "hl7.fhir.us.core::6.1.0::StructureDefinition-us-core-patient.json", "identifier"]`

**Key Design Notes**:
- When `snapshotId` is a `FileIndexEntryWithPkg`, it's normalized to: `packageId::packageVersion::filename`
- For snapshot cache with `FileIndexEntryWithPkg`, package ID/version slots are empty strings (already in normalized ID)
- Element cache uses `packageFilter` if provided, otherwise uses `packageContext`
- This ensures consistent cache keys regardless of how resources are accessed

## Package Context Namespacing

The element and children caches include a **package context namespace** derived from `FPE.getNormalizedRootPackages()`. This ensures:
- Safe sharing of external caches between navigator instances
- Different package contexts maintain separate cache entries
- Normalized packages are canonically stringified (already sorted and deduped)

For the **element cache**, if a `packageFilter` parameter is provided during element resolution, it takes precedence over the general package context for that specific cache entry.

The snapshot and type meta caches already include package information in their keys, so no additional namespacing is needed.

## LRU Sizing Strategy

Each cache always has an in-memory LRU hot layer, regardless of whether an external cache is provided. Providing an external cache does **not** change the in-memory LRU sizing; it simply adds an optional persistent/shared "cold" layer that entries can be promoted from.

Default LRU sizes:

| Cache Type     | Default LRU size | Rationale |
|----------------|------------------|-----------|
| Snapshot       | 100              | Snapshots are large; keep a reasonable hot working set in-memory |
| Type Meta      | 500              | Small metadata; cache many in-memory |
| Element        | 2000             | Frequently accessed; larger LRU improves path traversal locality |
| Children       | 500              | Arrays can be large; cache common lookups |

## Cache Interface

The `ICache<T>` interface supports both synchronous and asynchronous implementations:

```typescript
export interface ICache<T> {
  get(key: (string | number)[]): Promise<T | undefined> | T | undefined;
  set(key: (string | number)[], value: T): Promise<void> | void;
  has(key: (string | number)[]): Promise<boolean> | boolean;
  delete(key: (string | number)[]): Promise<boolean> | boolean;
  clear(): Promise<void> | void;
}
```

This allows:
- Synchronous in-memory implementations (Map, LRU)
- Asynchronous persistent implementations (LMDB, Redis, etc.)
- The navigator internally handles both with `async/await`

## Implementing a Custom Cache

### Example: LMDB Cache

```typescript
import { ICache } from '@outburn/structure-navigator';
import lmdb from 'lmdb';

export class LMDBCache<T> implements ICache<T> {
  private db: lmdb.Database;

  constructor(name: string, rootDb: lmdb.RootDatabase) {
    this.db = rootDb.openDB({ name, encoding: 'msgpack' });
  }

  async get(key: (string | number)[]): Promise<T | undefined> {
    return this.db.get(key);
  }

  async set(key: (string | number)[], value: T): Promise<void> {
    await this.db.put(key, value);
  }

  async has(key: (string | number)[]): Promise<boolean> {
    return this.db.doesExist(key);
  }

  async delete(key: (string | number)[]): Promise<boolean> {
    return this.db.remove(key);
  }

  async clear(): Promise<void> {
    await this.db.clearAsync();
  }
}
```

### Usage

```typescript
import { open } from 'lmdb';
import { FhirStructureNavigator } from '@outburn/structure-navigator';
import { LMDBCache } from './lmdb-cache';

const rootDb = open({ path: './cache-db', compression: true });

const nav = new FhirStructureNavigator(fsg, logger, {
  snapshotCache: new LMDBCache('snapshots', rootDb),
  typeMetaCache: new LMDBCache('typemeta', rootDb),
  elementCache: new LMDBCache('elements', rootDb),
  childrenCache: new LMDBCache('children', rootDb)
});
```

## Cache Separation

Each cache type is provided as a **separate interface instance**. This means:
- No manual namespacing needed (e.g., no `snapshot::`, `element::` prefixes)
- External implementations can choose their storage strategy
- Can mix and match: some caches external, others default
- Can use different backends for different cache types

Example - external snapshots only:
```typescript
const nav = new FhirStructureNavigator(fsg, logger, {
  snapshotCache: new LMDBCache('snapshots', rootDb)
  // Other caches will use default LRU-only
});
```
## Best Practices

1. **Use LMDB for production**: Provides persistence and cross-process sharing
2. **Size databases appropriately**: LMDB map size should accommodate growth
3. **Monitor cache hit rates**: Log cache misses to validate sizing and external cache ROI
4. **Share caches carefully**: Ensure package contexts align when sharing
5. **Consider compression**: LMDB compression can save significant disk space
6. **Separate by environment**: Dev/test/prod should have separate cache databases

## Future Enhancements

Potential improvements to the cache architecture:
- Cache eviction policies (TTL, size limits)
- Cache statistics and monitoring
- Batch operations for improved performance
- Cache warming strategies
- Distributed cache support (Redis, Memcached)
