/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-structure-navigator
 */

import { FhirSnapshotGenerator, ElementDefinition, ILogger, PackageIdentifier } from 'fhir-snapshot-generator';
import { customPrethrower, defaultLogger, defaultPrethrow, splitFshPath, initCap } from './utils';
import { ElementDefinitionType } from 'fhir-snapshot-generator/dist/types';
import { FileIndexEntryWithPkg } from 'fhir-package-explorer/dist/types';
import { FhirPackageExplorer } from 'fhir-package-explorer';

export interface EnrichedElementDefinitionType extends ElementDefinitionType {
  __kind?: string;
}

export interface EnrichedElementDefinition extends ElementDefinition {
  __fromDefinition: string;
  type?: EnrichedElementDefinitionType[];
}

const buildSnapshotCacheKey = (id: string | FileIndexEntryWithPkg, packageFilter?: PackageIdentifier): string => {
  if (typeof id === 'string') {
    const pkgId = packageFilter?.id ?? '';
    const pkgVer = packageFilter?.version ?? '';
    return `${id}::${pkgId}::${pkgVer}`;
  } else {
    const pkgId = id?.__packageId ?? '';
    const pkgVer = id?.__packageVersion ?? '';
    const filename = id?.filename ?? '';
    return `${pkgId}::${pkgVer}::${filename}`;
  }
};

export class FhirStructureNavigator {
  private fsg: FhirSnapshotGenerator;
  private logger: ILogger;
  // eslint-disable-next-line no-unused-vars
  private prethrow: (msg: Error | any) => Error;
  // private memory caches
  private snapshotCache = new Map<string, any>(); // TODO: Define a more specific type for StructureDefinition
  private typeMetaCache = new Map<string, FileIndexEntryWithPkg>();
  private elementCache = new Map<string, EnrichedElementDefinition>();
  private childrenCache = new Map<string, EnrichedElementDefinition[]>();
  
  constructor(fsg: FhirSnapshotGenerator, logger?: ILogger) {
    this.fsg = fsg;
    if (logger) {
      this.logger = logger;
      this.prethrow = customPrethrower(this.logger);
    } else {
      this.logger = defaultLogger;
      this.prethrow = defaultPrethrow;
    }
  }

  public getLogger(): ILogger {
    return this.logger;
  }

  public getFsg(): FhirSnapshotGenerator {
    return this.fsg;
  }

  public getFpe(): FhirPackageExplorer {
    return this.fsg.getFpe();
  }

  private async _getCachedSnapshot(id: string | FileIndexEntryWithPkg, packageFilter?: PackageIdentifier): Promise<any> {
    const key: string = buildSnapshotCacheKey(id, packageFilter);

    let snapshot = this.snapshotCache.get(key);
    if (!snapshot) {
      snapshot = await this.fsg.getSnapshot(id, packageFilter);
      const defUrl = snapshot.url;
      // Enrich each element
      for (const el of snapshot.snapshot.element as EnrichedElementDefinition[]) {
        el.__fromDefinition = defUrl;
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
                const corePackageId = snapshot.__corePackage.id;
                const corePackageVersion = snapshot.__corePackage.version;
                const key = `${t.code}::${corePackageId}::${corePackageVersion}`;
                let typeMeta = this.typeMetaCache.get(key);
                if (!typeMeta) {
                  typeMeta = await this.fsg.getFpe().resolveMeta({
                    resourceType: 'StructureDefinition',
                    id: t.code,
                    package: snapshot.__corePackage
                  });
                  if (typeMeta) {
                    this.typeMetaCache.set(key, typeMeta);
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
        }
      }

      this.snapshotCache.set(key, snapshot);
    }
    return snapshot;
  }

  public async getElement(
    snapshotId: string | FileIndexEntryWithPkg,
    fshPath: string
  ): Promise<EnrichedElementDefinition> {
    try {
      const segments = splitFshPath(fshPath);
      return await this._resolvePath(snapshotId, segments);
    } catch (error) {
      throw this.prethrow(error);
    }
  }

  public async getChildren(
    snapshotId: string | FileIndexEntryWithPkg,
    fshPath: string
  ): Promise<EnrichedElementDefinition[]> {
    try {
      // Check children cache
      let cacheKey = `${buildSnapshotCacheKey(snapshotId)}::${fshPath}`;
      const cached = this.childrenCache.get(cacheKey);
      if (cached) return cached;
      const segments = fshPath === '.' ? [] : splitFshPath(fshPath);

      const resolved = await this._resolvePath(snapshotId, segments);
      const parentId = resolved.id;

      const snapshot = await this._getCachedSnapshot(snapshotId);
      const elements = snapshot.snapshot.element as EnrichedElementDefinition[];

      const directChildren = elements.filter((el: EnrichedElementDefinition) => {
        if (!el.id?.startsWith(`${parentId}.`)) return false;
        const remainder = el.id.slice(parentId.length + 1);
        return remainder.length > 0 && !remainder.includes('.');
      });

      let result: EnrichedElementDefinition[];

      if (directChildren.length > 0) {
        result = directChildren.map(el => ({ ...el }));
        this.childrenCache.set(cacheKey, result); // ✅ Cache children
        return result;
      }

      // Check for contentReference
      if (resolved.contentReference) {
        const refPath = resolved.contentReference.split('#')[1];
        const baseType = snapshot.type;
        return await this.getChildren(baseType, refPath);
      }

      // if more than one type, we can't resolve children, throw an error
      if (resolved.type && resolved.type.length > 1) {
        throw new Error(
          `Cannot resolve children for choice type element ${resolved.path}.`
        );
      }

      // Rebase and continue under the base type
      const typeCode = resolved.type?.[0]?.code;
      if (typeCode) {
        const typeMeta = await this.fsg.getMetadata(typeCode, snapshot.__corePackage);
        cacheKey = `${buildSnapshotCacheKey(typeMeta)}::.`;
        const children = await this.getChildren(typeCode, '.');
        this.childrenCache.set(cacheKey, children);
        return children;
      }

      result = []; // No children found
      this.childrenCache.set(cacheKey, result); // ✅ Cache empty result
      return result;
    } catch (error) {
      throw this.prethrow(error);
    }
  }

  private async _resolvePath(
    snapshotId: string | FileIndexEntryWithPkg,
    pathSegments: string[],
    packageFilter?: PackageIdentifier,
    cameFromElement?: EnrichedElementDefinition
  ): Promise<EnrichedElementDefinition> {
    let cacheKey = `${buildSnapshotCacheKey(snapshotId, packageFilter)}::${pathSegments.join('.')}`;
    const cached = this.elementCache.get(cacheKey);
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
        // but if the element we cme from is polymorphic, we need to filter the __name array according to our resolved type
        if (cameFromElement.__name.length > 1) {
          const __name = cameFromElement.__name.filter((name: string) => {
            return name.endsWith(initCap(snapshot.type));
          });
          root.__name = __name;
        } else {
          root.__name = cameFromElement.__name;
        }
      }
      this.elementCache.set(cacheKey, root); // ✅ cache root
      return root;
    }

    let currentElement: EnrichedElementDefinition | undefined = elements[0];
    let previousElement: EnrichedElementDefinition | undefined;
    let currentPath = elements[0].id;
    let currentBaseUrl = snapshot.url;

    for (let i = 0; i < pathSegments.length; i++) {
      const subPath = pathSegments.slice(0, i + 1).join('.');
      cacheKey = `${buildSnapshotCacheKey(snapshotId, packageFilter)}::${subPath}`;
      const cached = this.elementCache.get(cacheKey);
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
          this.elementCache.set(cacheKey, currentElement); // ✅ cache after resolving slice
          continue;
        }
      }

      currentPath = currentElement.id;
      this.elementCache.set(cacheKey, currentElement); // ✅ cache after resolving each segment
    }

    const finalKey = `${buildSnapshotCacheKey(snapshotId, packageFilter)}::${pathSegments.join('.')}`;
    return this.elementCache.get(finalKey)!; // ✅ guaranteed to be set during traversal
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

        // 2b. Bracket form: value[valueString], value[valueCodeableConcept]
        const bracketMatch = searchPath.match(/^(.+)\[([^\]]+)\]$/);
        if (bracketMatch) {
          const [, outer, inner] = bracketMatch;
          if (outer === basePath) {
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
      const rebasedPath = [...refPath.split('.'), ...remainingSegments];
      return await this._resolvePath(snapshot.type, rebasedPath, snapshot.__corePackage);
    }

    const type = previous?.type?.[0];
    if (type) {
      const targetId = type.profile?.[0] || type.code;
      const targetPackage: PackageIdentifier | undefined = type.profile?.[0]
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
    corePackage: PackageIdentifier
  ): Promise<EnrichedElementDefinition | undefined> {
    const sliceId = `${baseElement.id}:${slice}`;
    const sliceMatch = elements.find(e => e.id === sliceId);
    if (sliceMatch) return sliceMatch;

    if (this._isPolymorphic(baseElement)) {
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
    corePackage: PackageIdentifier
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
