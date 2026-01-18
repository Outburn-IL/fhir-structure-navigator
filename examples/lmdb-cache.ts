/**
 * Example: LMDB-based persistent cache implementation
 * 
 * This demonstrates how to implement a production-ready cache
 * using LMDB for persistence and cross-process sharing.
 * 
 * Install: npm install lmdb
 */

import { ICache } from '@outburn/structure-navigator';
import type { Database, RootDatabase } from 'lmdb';

/**
 * LMDB cache implementation with array key support
 */
export class LMDBCache<T> implements ICache<T> {
  private db: Database<T, (string | number)[]>;

  constructor(name: string, rootDb: RootDatabase) {
    this.db = rootDb.openDB({
      name,
      encoding: 'msgpack', // Efficient binary serialization
      keyEncoding: 'ordered-binary' // Supports array keys with proper ordering
    }) as Database<T, (string | number)[]>;
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

  /**
   * Additional utility: Get cache statistics
   */
  async getStats(): Promise<{ entryCount: number }> {
    const stats = await this.db.getStats();
    return {
      entryCount: stats.entryCount || 0
    };
  }

  /**
   * Additional utility: Query by key prefix (range query)
   * Useful for debugging or cache analysis
   */
  async getByPrefix(prefix: (string | number)[]): Promise<T[]> {
    const results: T[] = [];
    const range = this.db.getRange({
      start: prefix
    });

    for (const { value, key } of range) {
      // Check if key starts with prefix
      if (this.keyStartsWith(key, prefix)) {
        results.push(value);
      } else {
        break; // Keys are ordered, so we can stop
      }
    }

    return results;
  }

  private keyStartsWith(key: (string | number)[], prefix: (string | number)[]): boolean {
    if (key.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (key[i] !== prefix[i]) return false;
    }
    return true;
  }
}

/**
 * Example usage with FhirStructureNavigator
 */
/*
import { open } from 'lmdb';
import { FhirStructureNavigator } from '@outburn/structure-navigator';
import { LMDBCache } from './lmdb-cache';

// Open root database with compression
const rootDb = open({
  path: './navigator-cache',
  compression: true,
  maxDbs: 10, // Allow multiple named databases
  mapSize: 2 * 1024 * 1024 * 1024, // 2GB max size
  noSync: false // Ensure durability
});

// Create separate caches for each type
const caches = {
  snapshotCache: new LMDBCache('snapshots', rootDb),
  typeMetaCache: new LMDBCache('typemeta', rootDb),
  elementCache: new LMDBCache('elements', rootDb),
  childrenCache: new LMDBCache('children', rootDb)
};

// Create navigator with persistent caches
const nav = new FhirStructureNavigator(fsg, logger, caches);

// Use the navigator - caches will persist across restarts
const element = await nav.getElement('Patient', 'identifier.system');

// Check cache stats
const snapshotStats = await caches.snapshotCache.getStats();
console.log(`Snapshot cache entries: ${snapshotStats.entryCount}`);

// Query by package context (for debugging)
const patientElements = await caches.elementCache.getByPrefix([
  '[{"id":"hl7.fhir.r4.core","version":"4.0.1"}]',
  'Patient'
]);
console.log(`Patient elements cached: ${patientElements.length}`);

// Cleanup on shutdown
process.on('exit', () => {
  rootDb.close();
});
*/

/**
 * Advanced: Shared cache across multiple navigator instances
 */
/*
import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FhirSnapshotGenerator } from 'fhir-snapshot-generator';

// Create two navigators with different package contexts
const fpe1 = await FhirPackageExplorer.create({
  context: ['hl7.fhir.r4.core@4.0.1'],
  cachePath: './.fhir-cache',
  fhirVersion: '4.0.1'
});

const fpe2 = await FhirPackageExplorer.create({
  context: ['hl7.fhir.us.core@6.1.0'], // Different context
  cachePath: './.fhir-cache',
  fhirVersion: '4.0.1'
});

const fsg1 = await FhirSnapshotGenerator.create({ fhirVersion: '4.0.1', fpe: fpe1 });
const fsg2 = await FhirSnapshotGenerator.create({ fhirVersion: '4.0.1', fpe: fpe2 });

// Both navigators share the same LMDB cache
// Package context namespacing ensures no conflicts
const nav1 = new FhirStructureNavigator(fsg1, logger, caches);
const nav2 = new FhirStructureNavigator(fsg2, logger, caches);

// nav1 and nav2 can safely share element/children caches
// because they have different package contexts
*/
