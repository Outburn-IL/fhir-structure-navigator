/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-structure-navigator
 */

import { FhirSnapshotGenerator, ElementDefinition, ILogger, PackageIdentifier } from 'fhir-snapshot-generator';
import { customPrethrower, defaultLogger, defaultPrethrow, splitFshPath, initCap } from './utils';
import { ElementDefinitionType } from 'fhir-snapshot-generator/dist/types';

export interface EnrichedElementDefinition extends ElementDefinition {
  __fromDefinition: string;
}

export class FhirStructureNavigator {
  private fsg: FhirSnapshotGenerator;
  private logger: ILogger;
  // eslint-disable-next-line no-unused-vars
  private prethrow: (msg: Error | any) => Error;
  
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

  async getElement(
    snapshotId: string,
    fshPath: string
  ): Promise<EnrichedElementDefinition> {
    try {
      const segments = splitFshPath(fshPath);
      return await this._resolvePath(snapshotId, segments);
    } catch (error) {
      throw this.prethrow(error);
    }
  }

  async getChildren(
    snapshotId: string,
    fshPath: string
  ): Promise<EnrichedElementDefinition[]> {
    try {
      const segments = fshPath === '.' ? [] : splitFshPath(fshPath);
      const resolved = await this._resolvePath(snapshotId, segments);
      const parentId = resolved.path!;
      const snapshotUrl = resolved.__fromDefinition;

      const snapshot = await this.fsg.getSnapshot(snapshotId);
      const elements = snapshot.snapshot.element;

      const directChildren = elements.filter((el: ElementDefinition) => {
        if (!el.id?.startsWith(`${parentId}.`)) return false;
        const remainder = el.id.slice(parentId.length + 1);
        return remainder.length > 0 && !remainder.includes('.');
      });

      if (directChildren.length > 0) {
        return directChildren.map((el: ElementDefinition) => ({
          ...el,
          __fromDefinition: snapshotUrl
        })) as EnrichedElementDefinition[];
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
        return await this.getChildren(typeCode, '.');
      }

      return []; // No children found
    } catch (error) {
      throw this.prethrow(error);
    }
  }

  private async _resolvePath(
    snapshotId: string,
    pathSegments: string[],
    packageFilter?: PackageIdentifier
  ): Promise<EnrichedElementDefinition> {
    const snapshot = await this.fsg.getSnapshot(snapshotId, packageFilter);
    const elements = snapshot.snapshot.element;

    if (pathSegments.length === 0) {
      return { ...elements[0], __fromDefinition: snapshot.url };
    }

    let currentElement: ElementDefinition | undefined = elements[0];
    let previousElement: ElementDefinition | undefined;
    let currentPath = elements[0].id;
    let currentBaseUrl = snapshot.url;

    for (let i = 0; i < pathSegments.length; i++) {
      const segment = pathSegments[i];
      const { base, slice } = this._parseSegment(segment);
      const searchPath = `${currentPath}.${base}`;
      previousElement = currentElement;

      const { element: resolvedElement, narrowedType } =
      this._resolveElementPathWithPolymorphism(elements, searchPath);

      currentElement = resolvedElement;

      if (currentElement && narrowedType) {
        const narrowed = { ...currentElement, type: [narrowedType] };
        const inferredSliceId = `${currentElement.id}:${this._inferredSliceName(currentElement.id, narrowedType.code)}`;
        const sliceMatch = elements.find(e => e.id === inferredSliceId);
        currentElement = sliceMatch || narrowed;
      }

      if (!currentElement) {
        const rebased = await this._attemptRebase(previousElement, snapshot, pathSegments.slice(i));
        if (rebased) return rebased;
        throw new Error(`"${segment}" not found under "${previousElement?.path}" in structure "${snapshotId}"`);
      }

      if (slice) {
        const resolved = await this._resolveSlice(currentElement, slice, elements, currentBaseUrl, snapshot.__corePackage);
        if (resolved) {
          // If resolved came from a new profile (virtual slice), restart traversal in that snapshot
          if (resolved.__fromDefinition !== currentBaseUrl) {
            const remaining = pathSegments.slice(i + 1);
            return await this._resolvePath(resolved.__fromDefinition, remaining);
          }

          currentElement = resolved;
          currentPath = resolved.path!;
          continue;
        }
      }

      currentPath = currentElement.path!;
    }

    return { ...currentElement, __fromDefinition: currentBaseUrl } as EnrichedElementDefinition;
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
    elements: ElementDefinition[],
    searchPath: string
  ): { element?: ElementDefinition; narrowedType?: { code: string } } {
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
    previous: ElementDefinition | undefined,
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
    baseElement: ElementDefinition,
    slice: string,
    elements: ElementDefinition[],
    baseUrl: string,
    corePackage: PackageIdentifier
  ): Promise<EnrichedElementDefinition | undefined> {
    const sliceId = `${baseElement.id}:${slice}`;
    const sliceMatch = elements.find(e => e.id === sliceId);
    if (sliceMatch) {
      return { ...sliceMatch, __fromDefinition: baseUrl };
    }

    if (this._isPolymorphic(baseElement)) {
      const matchedType = baseElement.type?.find(t => t.code === slice);
      if (matchedType) {
        const inferredSliceId = `${baseElement.id}:${this._inferredSliceName(baseElement.id, matchedType.code)}`;
        const inferredSliceMatch = elements.find(e => e.id === inferredSliceId);
        return inferredSliceMatch
          ? { ...inferredSliceMatch, __fromDefinition: baseUrl }
          : { ...baseElement, type: [matchedType], __fromDefinition: baseUrl };
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
      snapshot = await this.fsg.getSnapshot(id);
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
