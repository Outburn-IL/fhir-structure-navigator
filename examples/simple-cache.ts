/**
 * Example: Simple in-memory cache implementation
 * 
 * This demonstrates a basic synchronous cache that can be used
 * as a reference or for testing purposes.
 */

import { ICache } from '@outburn/structure-navigator';

/**
 * Simple Map-based cache implementation
 * Uses JSON serialization for array keys
 */
export class SimpleMapCache<T> implements ICache<T> {
  private cache = new Map<string, T>();

  private serializeKey(key: (string | number)[]): string {
    return JSON.stringify(key);
  }

  get(key: (string | number)[]): T | undefined {
    return this.cache.get(this.serializeKey(key));
  }

  set(key: (string | number)[], value: T): void {
    this.cache.set(this.serializeKey(key), value);
  }

  has(key: (string | number)[]): boolean {
    return this.cache.has(this.serializeKey(key));
  }

  delete(key: (string | number)[]): boolean {
    return this.cache.delete(this.serializeKey(key));
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Example usage with FhirStructureNavigator
 */
/*
import { FhirStructureNavigator } from '@outburn/structure-navigator';
import { SimpleMapCache } from './simple-cache';

const nav = new FhirStructureNavigator(fsg, logger, {
  snapshotCache: new SimpleMapCache(),
  elementCache: new SimpleMapCache(),
  childrenCache: new SimpleMapCache()
});
*/
