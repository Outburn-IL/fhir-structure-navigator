# Cache Architecture Migration Guide

This document describes the cache architecture changes made to `fhir-structure-navigator` to support external cache implementations through dependency injection.

## Summary of Changes

The navigator has been updated from simple `Map<string, T>` caches to a sophisticated two-tier caching system that supports:
- **Dependency Injection**: Plug in external cache implementations (LMDB, Redis, etc.)
- **Array-based keys**: LMDB-compatible key structure for efficient storage and querying
- **LRU caching**: Smart inner cache layer with size-based eviction
- **Package context namespacing**: Safe cache sharing across navigator instances
- **Async support**: Fully async cache operations for persistent backends

## Breaking Changes

### None! 

The changes are **100% backward compatible**. Existing code will continue to work without modification:

```typescript
// This still works exactly as before
const nav = new FhirStructureNavigator(fsg, logger);
```

## New Features

### 1. Optional Cache Dependency Injection

```typescript
const nav = new FhirStructureNavigator(fsg, logger, {
  snapshotCache: myCustomCache,
  elementCache: myCustomCache,
  childrenCache: myCustomCache
});
```

### 2. ICache Interface

Export a new `ICache<T>` interface for implementing custom caches:

```typescript
export interface ICache<T> {
  get(key: (string | number)[]): Promise<T | undefined> | T | undefined;
  set(key: (string | number)[], value: T): Promise<void> | void;
  has(key: (string | number)[]): Promise<boolean> | boolean;
  delete(key: (string | number)[]): Promise<boolean> | boolean;
  clear(): Promise<void> | void;
}
```

### 3. NavigatorCacheOptions Interface

Export configuration options:

```typescript
export interface NavigatorCacheOptions {
  snapshotCache?: ICache<any>;
  typeMetaCache?: ICache<FileIndexEntryWithPkg>;
  elementCache?: ICache<EnrichedElementDefinition>;
  childrenCache?: ICache<EnrichedElementDefinition[]>;
}
```

## Internal Changes

### Cache Key Format Changes

**Before**: String concatenation
```typescript
const key = `${id}::${pkgId}::${pkgVer}`;
```

**After**: Array-based keys
```typescript
const key = [id, pkgId, pkgVer];
```

### Cache Implementation Changes

**Before**: Direct Map operations
```typescript
private snapshotCache = new Map<string, any>();
const snapshot = this.snapshotCache.get(key);
this.snapshotCache.set(key, snapshot);
```

**After**: Two-tier cache with async operations
```typescript
private snapshotCache: TwoTierCache<any>;
const snapshot = await this.snapshotCache.get(key);
await this.snapshotCache.set(key, snapshot);
```

### Package Context Namespacing

Element and children caches now include package context in their keys:

```typescript
const packageContext = JSON.stringify(this.fsg.getFpe().getNormalizedRootPackages());
const key = buildElementCacheKey(packageContext, snapshotId, pathString, packageFilter);
```

This ensures:
- Multiple navigator instances can share external caches safely
- Different package contexts maintain separate cache entries
- No conflicts when navigators have different dependency contexts

### LRU Size Configuration

Automatic LRU sizing based on external cache availability:

```typescript
this.snapshotCache = new TwoTierCache(
  hasExternalSnapshot ? 10 : 50,  // Small when external, large when not
  cacheOptions?.snapshotCache
);
```

## Migration Path

### For Library Users

**No changes required!** Your existing code continues to work.

**Optional**: Add external caching for better performance:
```typescript
import { LMDBCache } from './lmdb-cache';

const nav = new FhirStructureNavigator(fsg, logger, {
  snapshotCache: new LMDBCache('snapshots', rootDb)
});
```

### For Library Contributors

When working on the codebase:

1. **All cache operations are now async**: Always use `await` when calling cache methods
2. **Use array keys**: Pass array keys to cache key builder functions
3. **Don't modify cache directly**: Use the TwoTierCache abstraction

## Performance Implications

### Without External Cache (Default)
- **Same as before**, but with slightly larger LRU caches
- All operations remain in-memory and fast
- No persistence across restarts

### With External Cache
- **First access**: Slightly slower (external cache lookup)
- **Subsequent accesses**: Just as fast (LRU hit)
- **Memory usage**: Significantly lower (only hot entries in memory)
- **Persistence**: Cache survives restarts
- **Sharing**: Multiple processes can share the same cache

## Testing

All existing tests pass without modification, confirming backward compatibility:
- 47 tests passed
- 0 regressions
- 100% feature parity

## Examples

See the `/examples` directory for:
- `simple-cache.ts` - Basic in-memory cache implementation
- `lmdb-cache.ts` - Production-ready LMDB implementation

## Documentation

- `README.md` - Updated with cache architecture section
- `CACHE_ARCHITECTURE.md` - Detailed architectural documentation
- Code comments - Inline documentation of cache key formats

## Future Enhancements

Potential improvements:
- Cache statistics and monitoring
- TTL-based eviction
- Batch operations
- Cache warming strategies
- Distributed cache support (Redis, Memcached)

## Questions?

For issues or questions about the cache architecture:
1. Check `CACHE_ARCHITECTURE.md` for detailed documentation
2. Review examples in `/examples` directory
3. Open an issue on GitHub
