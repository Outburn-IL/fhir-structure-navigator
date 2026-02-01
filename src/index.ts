/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-structure-navigator
 */

import type { FhirSnapshotGenerator } from 'fhir-snapshot-generator';
import type { Logger, FhirPackageIdentifier, ElementDefinition, ElementDefinitionType, FileIndexEntryWithPkg } from '@outburn/types';
import { splitFshPath, initCap } from './utils';
import type { FhirPackageExplorer } from 'fhir-package-explorer';
import { LRUCache as LRU } from 'lru-cache';

/**
 * Generic cache interface supporting array-based keys for LMDB compatibility
 */
export interface ICache<T> {
  get(key: (string | number)[]): Promise<T | undefined> | T | undefined;
  set(key: (string | number)[], value: T): Promise<void> | void;
  has(key: (string | number)[]): Promise<boolean> | boolean;
  delete(key: (string | number)[]): Promise<boolean> | boolean;
  clear(): Promise<void> | void;
}

/**
 * LRU Cache implementation as inner super-hot layer
 * Uses lru-cache library for O(1) eviction performance
 */
class LRUCache<T extends {}> implements ICache<T> {
  private cache: LRU<string, T, unknown>;

  constructor(maxSize: number) {
    this.cache = new LRU<string, T, unknown>({ max: maxSize });
  }

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
}

/**
 * Two-tier cache combining fast LRU with optional external cache
 */
class TwoTierCache<T extends {}> implements ICache<T> {
  private lru: LRUCache<T>;
  private external?: ICache<T>;

  constructor(lruSize: number, external?: ICache<T>) {
    this.lru = new LRUCache(lruSize);
    this.external = external;
  }

  async get(key: (string | number)[]): Promise<T | undefined> {
    // Check LRU first
    const lruValue = this.lru.get(key);
    if (lruValue !== undefined) {
      return lruValue;
    }

    // Check external cache
    if (this.external) {
      try {
        const externalValue = await this.external.get(key);
        if (externalValue !== undefined) {
          // Promote to LRU
          this.lru.set(key, externalValue);
          return externalValue;
        }
      } catch {
        // External cache error - continue with LRU-only operation
      }
    }

    return undefined;
  }

  async set(key: (string | number)[], value: T): Promise<void> {
    // Always set in LRU
    this.lru.set(key, value);
    
    // Set in external if available
    if (this.external) {
      // Fire-and-forget: do not block the caller on external cache latency.
      // Swallow both sync throws and async rejections (errors are intentionally ignored).
      void Promise.resolve()
        .then(() => this.external!.set(key, value))
        .catch(() => {
          // External cache error - continue (LRU is already set)
        });
    }
  }

  async has(key: (string | number)[]): Promise<boolean> {
    if (this.lru.has(key)) {
      return true;
    }
    if (this.external) {
      try {
        return await this.external.has(key);
      } catch {
        // External cache error - fall back to LRU result
        return false;
      }
    }
    return false;
  }

  async delete(key: (string | number)[]): Promise<boolean> {
    const lruDeleted = this.lru.delete(key);
    if (this.external) {
      try {
        const externalDeleted = await this.external.delete(key);
        return lruDeleted || externalDeleted;
      } catch {
        // External cache error - return LRU result only
        return lruDeleted;
      }
    }
    return lruDeleted;
  }

  async clear(): Promise<void> {
    this.lru.clear();
    if (this.external) {
      try {
        await this.external.clear();
      } catch {
        // External cache error - continue (LRU is already cleared)
      }
    }
  }
}

export interface EnrichedElementDefinitionType extends ElementDefinitionType {
  __kind?: string;
}

export interface EnrichedElementDefinition extends ElementDefinition {
  __fromDefinition: string;
  __corePackage: FhirPackageIdentifier;
  __packageId: string,
  __packageVersion: string;
  __name?: string[];
  type?: EnrichedElementDefinitionType[];
}

export interface NavigatorCacheOptions {
  snapshotCache?: ICache<any>;
  typeMetaCache?: ICache<FileIndexEntryWithPkg>;
  elementCache?: ICache<EnrichedElementDefinition>;
  childrenCache?: ICache<EnrichedElementDefinition[]>;
}

/**
 * Build array-based cache key for snapshot cache
 * Format: [normalizedSnapshotId, packageId, packageVersion]
 */
const buildSnapshotCacheKey = (id: string | FileIndexEntryWithPkg, packageFilter?: FhirPackageIdentifier): (string | number)[] => {
  if (typeof id === 'string') {
    const pkgId = packageFilter?.id ?? '';
    const pkgVer = packageFilter?.version ?? '';
    return [id, pkgId, pkgVer];
  } else {
    const pkgId = id?.__packageId ?? '';
    const pkgVer = id?.__packageVersion ?? '';
    const filename = id?.filename ?? '';
    const normalizedId = `${pkgId}::${pkgVer}::${filename}`;
    return [normalizedId, '', ''];
  }
};

/**
 * Build array-based cache key for type meta cache
 * Format: [typeCode, corePackageId, corePackageVersion]
 */
const buildTypeMetaCacheKey = (typeCode: string, corePackage: FhirPackageIdentifier): (string | number)[] => {
  return [typeCode, corePackage.id, corePackage.version ?? ''];
};

/**
 * Build array-based cache key for element cache (includes package context namespace)
 * Format: [packageContext, normalizedSnapshotId, pathSegments]
 */
const buildElementCacheKey = (
  packageContext: string,
  snapshotId: string | FileIndexEntryWithPkg,
  pathSegments: string,
  packageFilter?: FhirPackageIdentifier
): (string | number)[] => {
  // Use packageFilter if provided, otherwise use packageContext
  const contextKey = packageFilter 
    ? JSON.stringify([{ id: packageFilter.id, version: packageFilter.version ?? '' }])
    : packageContext;
  
  if (typeof snapshotId === 'string') {
    return [contextKey, snapshotId, pathSegments];
  } else {
    const pkgId = snapshotId?.__packageId ?? '';
    const pkgVer = snapshotId?.__packageVersion ?? '';
    const filename = snapshotId?.filename ?? '';
    const normalizedId = `${pkgId}::${pkgVer}::${filename}`;
    return [contextKey, normalizedId, pathSegments];
  }
};

/**
 * Build array-based cache key for children cache (includes package context namespace)
 * Format: [packageContext, normalizedSnapshotId, fshPath]
 */
const buildChildrenCacheKey = (
  packageContext: string,
  snapshotId: string | FileIndexEntryWithPkg,
  fshPath: string
): (string | number)[] => {
  if (typeof snapshotId === 'string') {
    return [packageContext, snapshotId, fshPath];
  } else {
    const pkgId = snapshotId?.__packageId ?? '';
    const pkgVer = snapshotId?.__packageVersion ?? '';
    const filename = snapshotId?.filename ?? '';
    const normalizedId = `${pkgId}::${pkgVer}::${filename}`;
    return [packageContext, normalizedId, fshPath];
  }
};

export class FhirStructureNavigator {
  private fsg: FhirSnapshotGenerator;
  private logger: Logger;
  private packageContext: string;
  
  // Two-tier caches (LRU + optional external)
  private snapshotCache: TwoTierCache<any>;
  private typeMetaCache: TwoTierCache<FileIndexEntryWithPkg>;
  private elementCache: TwoTierCache<EnrichedElementDefinition>;
  private childrenCache: TwoTierCache<EnrichedElementDefinition[]>;
  
  constructor(fsg: FhirSnapshotGenerator, logger?: Logger, cacheOptions?: NavigatorCacheOptions) {
    this.fsg = fsg;
    this.logger = logger || {
      // no-op logger
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    };

    // Get normalized root packages for cache namespace
    const normalizedPackages = this.fsg.getFpe().getNormalizedRootPackages();
    this.packageContext = JSON.stringify(normalizedPackages);

    // Initialize two-tier caches with appropriate LRU sizes
    const hasExternalSnapshot = !!cacheOptions?.snapshotCache;
    const hasExternalTypeMeta = !!cacheOptions?.typeMetaCache;
    const hasExternalElement = !!cacheOptions?.elementCache;
    const hasExternalChildren = !!cacheOptions?.childrenCache;

    this.snapshotCache = new TwoTierCache(
      hasExternalSnapshot ? 10 : 50,
      cacheOptions?.snapshotCache
    );
    
    this.typeMetaCache = new TwoTierCache(
      hasExternalTypeMeta ? 50 : 500,
      cacheOptions?.typeMetaCache
    );
    
    this.elementCache = new TwoTierCache(
      hasExternalElement ? 50 : 250,
      cacheOptions?.elementCache
    );
    
    this.childrenCache = new TwoTierCache(
      hasExternalChildren ? 20 : 100,
      cacheOptions?.childrenCache
    );
  }

  public getLogger(): Logger {
    return this.logger;
  }

  public getFsg(): FhirSnapshotGenerator {
    return this.fsg;
  }

  public getFpe(): FhirPackageExplorer {
    return this.fsg.getFpe();
  }

  private async _getCachedSnapshot(id: string | FileIndexEntryWithPkg, packageFilter?: FhirPackageIdentifier): Promise<any> {
    const key = buildSnapshotCacheKey(id, packageFilter);

    let snapshot = await this.snapshotCache.get(key);
    if (!snapshot) {
      snapshot = await this.fsg.getSnapshot(id, packageFilter);
      // Enrich each element
      for (const el of snapshot.snapshot.element as EnrichedElementDefinition[]) {
        el.__fromDefinition = snapshot.url;
        el.__corePackage = snapshot.__corePackage;
        el.__packageId = snapshot.__packageId;
        el.__packageVersion = snapshot.__packageVersion;
        [
          'alias',
          'mapping',
          'mustSupport',
          'isSummary',
          'isModifier',
          'requirements',
          'representation',
          'comment',
          'definition',
          'isModifierReason',
          'meaningWhenMissing',
          'example',
          'short'
        ].map((attribute) => delete el[attribute]);

        // Remove xpath from constraint array
        if (Array.isArray(el.constraint)) {
          for (const c of el.constraint) {
            delete c.xpath;
          }
        }
        
        if (el.type && Array.isArray(el.type)) {
          for (const t of el.type) {
            if (!t.code) continue;

            if (t.code.startsWith('http://hl7.org/fhirpath/System.')) {
              (t as EnrichedElementDefinitionType).__kind = 'system';
            } else {
              try {
                const typeMetaKey = buildTypeMetaCacheKey(t.code, snapshot.__corePackage);
                let typeMeta = await this.typeMetaCache.get(typeMetaKey);
                if (!typeMeta) {
                  typeMeta = await this.fsg.getFpe().resolveMeta({
                    resourceType: 'StructureDefinition',
                    id: t.code,
                    package: snapshot.__corePackage
                  });
                  if (typeMeta) {
                    await this.typeMetaCache.set(typeMetaKey, typeMeta);
                  }
                }
                if (typeMeta?.kind) {
                  (t as EnrichedElementDefinitionType).__kind = typeMeta.kind;
                }
              } catch {
                // Lookup failed – skip
              }
            }
          }

          // Compute __name
          const lastSegment = el.path.split('.').pop()!;
          if (el.type.length === 1) {
            const t = el.type[0];
            if (lastSegment.endsWith('[x]')) {
              const base = lastSegment.slice(0, -3);
              el.__name = [`${base}${initCap(t.code!)}`];
            } else {
              el.__name = [lastSegment];
            }
          } else if (el.type.length > 1 && lastSegment.endsWith('[x]')) {
            const base = lastSegment.slice(0, -3);
            el.__name = el.type.map(t => `${base}${initCap(t.code!)}`);
          }
        } else if (el.contentReference) {
          // Handle contentReference elements - extract name from contentReference
          const name = el.contentReference.split('.').pop()!;
          el.__name = [name];
        }
      }

      await this.snapshotCache.set(key, snapshot);
    }
    return snapshot;
  }

  public async getElement(
    snapshotId: string | FileIndexEntryWithPkg,
    fshPath: string
  ): Promise<EnrichedElementDefinition> {
    const segments = splitFshPath(fshPath);
    return await this._resolvePath(snapshotId, segments);
  }

  public async getChildren(
    snapshotId: string | FileIndexEntryWithPkg,
    fshPath: string
  ): Promise<EnrichedElementDefinition[]> {
    // Check children cache
    let cacheKey = buildChildrenCacheKey(this.packageContext, snapshotId, fshPath);
    const cached = await this.childrenCache.get(cacheKey);
    if (cached) return cached;
    const segments = fshPath === '.' ? [] : splitFshPath(fshPath);

    const resolved = await this._resolvePath(snapshotId, segments);
    const parentId = resolved.id;

    // Use the snapshot from the resolved element if it's from a different profile
    let actualSnapshotId = snapshotId;
    if (resolved.__fromDefinition && resolved.__fromDefinition !== (typeof snapshotId === 'string' ? snapshotId : snapshotId.filename)) {
      // If the resolved element is from a different profile, use that profile's snapshot
      actualSnapshotId = resolved.__fromDefinition;
      cacheKey = buildChildrenCacheKey(this.packageContext, actualSnapshotId, fshPath);
      const profileCached = await this.childrenCache.get(cacheKey);
      if (profileCached) return profileCached;
    }

    const snapshot = await this._getCachedSnapshot(actualSnapshotId);
    const elements = snapshot.snapshot.element as EnrichedElementDefinition[];

    const directChildren = elements.filter((el: EnrichedElementDefinition) => {
      if (!el.id?.startsWith(`${parentId}.`)) return false;
      const remainder = el.id.slice(parentId.length + 1);
      return remainder.length > 0 && !remainder.includes('.');
    });

    let result: EnrichedElementDefinition[];

    if (directChildren.length > 0) {
      result = directChildren.map(el => ({ ...el }));
      await this.childrenCache.set(cacheKey, result); // ✅ Cache children
      return result;
    }

    // Check for contentReference
    if (resolved.contentReference) {
      const refPath = resolved.contentReference.split('#')[1];
      const baseType = snapshot.type;
      
      // Remove the base type prefix from the reference path if present
      // e.g., "#Bundle.link" should become "link" when baseType is "Bundle"
      const cleanRefPath = refPath.startsWith(`${baseType}.`) 
        ? refPath.substring(`${baseType}.`.length)
        : refPath;
      
      return await this.getChildren(baseType, cleanRefPath);
    }

    // if more than one type, we can't resolve children, throw an error
    if (resolved.type && resolved.type.length > 1) {
      throw new Error(
        `Cannot resolve children for choice type element ${resolved.path}.`
      );
    }

    // Rebase and continue under the target snapshot.
    // Prefer a profiled type (element.type.profile[0]) when available over the base type code.
    const typeInfo = resolved.type?.[0];
    if (typeInfo) {
      // Determine target snapshot id: use first profile canonical if present, otherwise base code
      let targetId = typeInfo.code;
      let isProfile = false;
      if (typeInfo.profile?.length) {
        // Extract simple id from canonical (last path segment before |version if present)
        const canonical = typeInfo.profile[0];
        const simpleId = canonical.split('/').pop()?.split('|')[0];
        if (simpleId) {
          targetId = simpleId;
          isProfile = true;
        } else {
          targetId = canonical; // fallback
          isProfile = true;
        }
      }

      let children: EnrichedElementDefinition[];
      if (resolved.id === targetId) {
        // we are at the root of the (profile) snapshot already
        const profileMeta = await this.fsg.getMetadata(resolved.__fromDefinition, { id: resolved.__packageId, version: resolved.__packageVersion });
        cacheKey = buildChildrenCacheKey(this.packageContext, profileMeta, '.');
        children = await this.getChildren(resolved.__fromDefinition, '.');
      } else {
        if (isProfile) {
          // Directly fetch children from the profile snapshot root
          cacheKey = buildChildrenCacheKey(this.packageContext, targetId, '.');
          children = await this.getChildren(targetId, '.');
        } else {
          // Base type path (previous logic)
          const typeMeta = await this.fsg.getMetadata(targetId, snapshot.__corePackage);
          cacheKey = buildChildrenCacheKey(this.packageContext, typeMeta, '.');
          children = await this.getChildren(targetId, '.');
        }
      }
      await this.childrenCache.set(cacheKey, children);
      return children;
    }

    result = []; // No children found
    await this.childrenCache.set(cacheKey, result); // ✅ Cache empty result
    return result;
  }

  private async _resolvePath(
    snapshotId: string | FileIndexEntryWithPkg,
    pathSegments: string[],
    packageFilter?: FhirPackageIdentifier,
    cameFromElement?: EnrichedElementDefinition
  ): Promise<EnrichedElementDefinition> {
    const pathString = pathSegments.join('.');
    let cacheKey = buildElementCacheKey(this.packageContext, snapshotId, pathString, packageFilter);
    const cached = await this.elementCache.get(cacheKey);
    if (cached) return cached;

    const snapshot = await this._getCachedSnapshot(snapshotId, packageFilter);
    const elements = snapshot.snapshot.element as EnrichedElementDefinition[];

    if (pathSegments.length === 0) {
      const root = {
        ...elements[0],
        type: [{ code: snapshot.type, __kind: snapshot.kind }] as EnrichedElementDefinitionType[],
      } as EnrichedElementDefinition;
      if (cameFromElement && cameFromElement.__name) {
        // If we came from a specific element, inherit its __name
        // but if the element we came from is polymorphic, we need to filter the __name array according to our resolved type
        if (cameFromElement.__name.length > 1) {
          const __name = cameFromElement.__name.filter((name: string) => {
            return name.endsWith(initCap(snapshot.type));
          });
          root.__name = __name;
        } else {
          root.__name = cameFromElement.__name;
        }
      }
      await this.elementCache.set(cacheKey, root); // ✅ cache root
      return root;
    }

    let currentElement: EnrichedElementDefinition | undefined = elements[0];
    let previousElement: EnrichedElementDefinition | undefined;
    let currentPath = elements[0].id;
    let currentBaseUrl = snapshot.url;

    for (let i = 0; i < pathSegments.length; i++) {
      const subPath = pathSegments.slice(0, i + 1).join('.');
      cacheKey = buildElementCacheKey(this.packageContext, snapshotId, subPath, packageFilter);
      const cached = await this.elementCache.get(cacheKey);
      if (cached) {
        currentElement = cached;
        currentPath = cached.id;
        currentBaseUrl = cached.__fromDefinition;
        continue;
      }

      const segment = pathSegments[i];
      const { base, slice } = this._parseSegment(segment);
      const searchPath = `${currentPath}.${base}`;
      previousElement = currentElement;

      const { element: resolvedElement, narrowedType } =
      this._resolveElementPathWithPolymorphism(elements, searchPath);

      currentElement = resolvedElement;

      if (currentElement && narrowedType) {
        // If we found a polymorphic match, we need to narrow it down
        // to the specific type we are looking for
        // This also affects the __name array
        const __name = this._inferredSliceName(currentElement.id, narrowedType.code);
        const narrowed = { ...currentElement, type: [narrowedType], __name: [__name] } as EnrichedElementDefinition;
        const inferredSliceId = `${currentElement.id}:${__name}`;
        const sliceMatch = elements.find(e => e.id === inferredSliceId);
        currentElement = sliceMatch || narrowed;
      }

      if (!currentElement) {
        const rebased = await this._attemptRebase(previousElement, snapshot, pathSegments.slice(i));
        if (rebased) return rebased;
        throw new Error(`"${segment}" not found under "${previousElement?.path}" in structure "${typeof snapshotId === 'string' ? snapshotId : JSON.stringify(snapshotId, null, 2)}"`);
      }

      if (slice) {
        const resolved = await this._resolveSlice(currentElement, slice, elements, snapshot.__corePackage);
        if (resolved) {
        // If resolved came from a new profile (virtual slice), restart traversal in that snapshot
          if (resolved.__fromDefinition !== currentBaseUrl) {
            const remaining = pathSegments.slice(i + 1);
            return await this._resolvePath(resolved.__fromDefinition, remaining, undefined, currentElement);
          }

          currentElement = resolved;
          currentPath = resolved.id;
          await this.elementCache.set(cacheKey, currentElement); // ✅ cache after resolving slice
          continue;
        }
      }

      currentPath = currentElement.id;
      await this.elementCache.set(cacheKey, currentElement); // ✅ cache after resolving each segment
    }

    const finalKey = buildElementCacheKey(this.packageContext, snapshotId, pathString, packageFilter);
    const finalElement = await this.elementCache.get(finalKey);
    return finalElement!; // ✅ guaranteed to be set during traversal
  }


  /**
   * Parses a single FSH-style path segment into its base element name and optional slice name.
   * @param segment - The FSH-style path segment, e.g., extension[birth-sex], valueString
   * @return An object containing the base element name and optional slice name.
   *         If no slice is present, the slice property will be undefined.
   */
  private _parseSegment(segment: string): { base: string; slice?: string } {
    const match = /^([^\[\]:]+)(?:\[(.+?)\])?$/.exec(segment);
    return match ? { base: match[1], slice: match[2] } : { base: segment };
  }

  private _isPolymorphic(el?: ElementDefinition): boolean {
    return !!el?.path?.endsWith('[x]');
  }

  private _resolveElementPathWithPolymorphism(
    elements: EnrichedElementDefinition[],
    searchPath: string
  ): { element?: EnrichedElementDefinition; narrowedType?: EnrichedElementDefinitionType } {
    for (const el of elements) {
    // 1. Direct match
      if (el.id === searchPath || el.id === `${searchPath}[x]`) {
        return { element: el };
      }

      // 2. Handle polymorphic base element
      if (this._isPolymorphic(el)) {
        const basePath = el.id.slice(0, -3); // remove [x]

        // 2a. Canonical suffix form: valueString, valueCodeableConcept
        const aliasMatch = el.type?.find(t => `${basePath}${initCap(t.code)}` === searchPath);
        if (aliasMatch) return { element: el, narrowedType: aliasMatch };

        // 2b. Bracket form: value[valueString], value[valueCodeableConcept], value[x]
        const bracketMatch = searchPath.match(/^(.+)\[([^\]]+)\]$/);
        if (bracketMatch) {
          const [, outer, inner] = bracketMatch;
          if (outer === basePath) {
            // Special case: value[x] is equivalent to value for polymorphic elements
            if (inner === 'x') {
              return { element: el };
            }
            const matchedType = el.type?.find(t => inner === `${outer}${initCap(t.code)}` || inner === initCap(t.code));
            if (matchedType) {
              return { element: el, narrowedType: matchedType };
            }
          }
        }
      }
    }

    return { element: undefined };
  }

  private _inferredSliceName(elementId: string, typeCode: string): string {
    const lastSegment = elementId.split('.').pop() ?? '';
    const baseName = lastSegment.slice(0, -3); // remove [x]
    return `${baseName}${initCap(typeCode)}`;
  }

  private async _attemptRebase(
    previous: EnrichedElementDefinition | undefined,
    snapshot: any,
    remainingSegments: string[]
  ): Promise<EnrichedElementDefinition | undefined> {
    if (previous?.contentReference) {
      const refPath = previous.contentReference.split('#')[1];
      const baseType = snapshot.type;
      
      // Remove the base type prefix from the reference path if present
      const cleanRefPath = refPath.startsWith(`${baseType}.`) 
        ? refPath.substring(`${baseType}.`.length)
        : refPath;
      
      const rebasedPath = [...cleanRefPath.split('.'), ...remainingSegments];
      return await this._resolvePath(baseType, rebasedPath, snapshot.__corePackage);
    }

    const type = previous?.type?.[0];
    if (type) {
      const targetId = type.profile?.[0] || type.code;
      const targetPackage: FhirPackageIdentifier | undefined = type.profile?.[0]
        ? { id: snapshot.__packageId, version: snapshot.__packageVersion }
        : snapshot.__corePackage;
      return await this._resolvePath(targetId, remainingSegments, targetPackage);
    }

    return undefined;
  }

  private async _resolveSlice(
    baseElement: EnrichedElementDefinition,
    slice: string,
    elements: EnrichedElementDefinition[],
    corePackage: FhirPackageIdentifier
  ): Promise<EnrichedElementDefinition | undefined> {
    const sliceId = `${baseElement.id}:${slice}`;
    const sliceMatch = elements.find(e => e.id === sliceId);
    if (sliceMatch) return sliceMatch;

    if (this._isPolymorphic(baseElement)) {
      // Special case: slice name 'x' on polymorphic elements means return the base element
      if (slice === 'x') {
        return { ...baseElement };
      }
      
      const matchedType = baseElement.type?.find(t => t.code === slice);
      if (matchedType) {
        const inferredSliceName = this._inferredSliceName(baseElement.id, matchedType.code);
        const inferredSliceId = `${baseElement.id}:${inferredSliceName}`;
        const inferredSliceMatch = elements.find(e => e.id === inferredSliceId);
        return inferredSliceMatch
          ? { ...inferredSliceMatch }
          : { ...baseElement, type: [matchedType], __name: [inferredSliceName] } as EnrichedElementDefinition;
      }
    }
    const allowedTypes = baseElement.type || [];
    const trySnapshot = await this._tryResolveSnapshot(slice, allowedTypes, corePackage);
    if (trySnapshot) {
      // Re-enter _resolvePath with remaining segments in the new profile
      // Remove the current segment from path and continue traversal
      return await this._resolvePath(
        slice,
        [], // Let outer loop handle path continuation
        {
          id: trySnapshot.__packageId,
          version: trySnapshot.__packageVersion
        }
      ); 
    }

    throw new Error(
      `"${slice}" is not a known slice of ${baseElement.id}, a valid type, or a resolvable StructureDefinition`
    );
  }

  private async _tryResolveSnapshot(
    id: string,
    allowedTypes: ElementDefinitionType[],
    corePackage: FhirPackageIdentifier
  ): Promise<any> {
    const isAllowed = (snapshotType: string): boolean => allowedTypes.some(t => t.code === snapshotType);
    let snapshot: any;
    // 1. Try resolving as type id in the core package context
    try {
      snapshot = await this.fsg.getFpe().lookup({ id, package: corePackage, resourceType: 'StructureDefinition' });
    } catch {
      // ignore if not found
    }
    if (Array.isArray(snapshot) && snapshot.length === 1) {
      if (!isAllowed(snapshot[0].type)) {
        throw new Error(
          `"${id}" has type "${snapshot[0].type}", which is not allowed here. Expected one of: ${allowedTypes.map(t => t.code).join(', ')}`
        );
      }
      return snapshot[0];
    }

    // 2. Try resolving without package context
    try {
      snapshot = await this._getCachedSnapshot(id);
    } catch {
      // ignore if not found
    }
    if (snapshot && snapshot.type) {
      if (!isAllowed(snapshot.type)) {
        throw new Error(
          `Profile "${id}" has type "${snapshot.type}", which is not allowed here. Expected one of: ${allowedTypes.map(t => t.code).join(', ')}`
        );
      }
      return snapshot;
    }
    return null; // not found at all
  }

}
