/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-structure-navigator
 */

import { FhirSnapshotGenerator, ElementDefinition, ILogger, PackageIdentifier } from 'fhir-snapshot-generator';
import { customPrethrower, defaultLogger, defaultPrethrow, splitFshPath, initCap } from './utils';

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

    const elements: ElementDefinition[] = snapshot.snapshot.element;

    if (pathSegments.length === 0) {
      return {
        ...elements[0],
        __fromDefinition: snapshot.url
      };
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

        // Attempt to find an explicit slice for the narrowed type
        const lastSegment = currentElement.id?.split('.').pop() ?? '';
        const baseName = lastSegment.slice(0, -3); // remove [x]
        const sliceName = `${baseName}${initCap(narrowedType.code)}`;
        const sliceId = `${currentElement.id}:${sliceName}`;
        const sliceMatch = elements.find(e => e.id === sliceId);

        if (sliceMatch) {
          currentElement = sliceMatch;
        } else {
          currentElement = narrowed;
        }
      }


      // Handle rebasing by contentReference
      if (!currentElement && previousElement?.contentReference) {
        const refPath = previousElement.contentReference.split('#')[1];
        const baseDef = snapshot.type;
        const rebasedPath = [...refPath.split('.'), ...pathSegments.slice(i)];
        return await this._resolvePath(baseDef, rebasedPath, snapshot.__corePackage);
      }

      // If still not found, try rebasing via base type
      if (!currentElement && previousElement && previousElement?.type?.length === 1) {
        const typeObj = previousElement.type[0];
        const profileUrl = Array.isArray(typeObj.profile) ? typeObj.profile[0] : undefined;
        const baseTypeId = typeObj.code;
        const rebasedPath = pathSegments.slice(i);
        if (!profileUrl) {
          // base types must be resolved in the context of the core package
          return await this._resolvePath(baseTypeId, rebasedPath, snapshot.__corePackage);
        } else {
          // profiles are resolved in the context of the source snapshot's package
          return await this._resolvePath(
            profileUrl,
            rebasedPath,
            {
              id: snapshot.__packageId,
              version: snapshot.__packageVersion
            }
          );
        }
      }

      if (!currentElement) {
        throw new Error(`"${segment}" not found under "${previousElement?.path}" in structure "${snapshotId}"`);
      }

      // Handle slice syntax
      if (slice) {
        const sliceId = `${currentElement.id}:${slice}`;
        const sliceMatch = elements.find(el => el.id === sliceId);

        if (sliceMatch) {
          currentElement = sliceMatch;
        } else if (this._isPolymorphic(currentElement)) {
          const matchedType = currentElement.type?.find(
            t => t.code === slice
          );

          if (matchedType) {
            const lastSegment = currentElement.id?.split('.').pop() ?? '';
            const baseName = lastSegment.slice(0, -3); // remove [x]
            const inferredSliceName = `${baseName}${initCap(matchedType.code)}`;
            const inferredSliceId = `${currentElement.id}:${inferredSliceName}`;
            const inferredSliceMatch = elements.find(e => e.id === inferredSliceId);

            if (inferredSliceMatch) {
              currentElement = inferredSliceMatch;
            } else {
              currentElement = { ...currentElement, type: [matchedType] };
            }
          } else {
            const trySnapshot = await this._tryResolveSnapshot(slice);
            if (trySnapshot) {
              return await this._resolvePath(trySnapshot, pathSegments.slice(i + 1));
            }
            throw new Error(
              `"${slice}" is not a known slice of ${searchPath}, a valid type for ${currentElement.path}, or a resolvable StructureDefinition`
            );
          }
        } else {
          const trySnapshot = await this._tryResolveSnapshot(slice);
          if (trySnapshot) {
            return await this._resolvePath(trySnapshot, pathSegments.slice(i + 1));
          }
          throw new Error(
            `"${slice}" is not a known slice of ${searchPath}, or a resolvable StructureDefinition`
          );
        }
      }
      currentPath = currentElement.path!;
    }

    return {
      ...currentElement,
      __fromDefinition: currentBaseUrl
    };
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

      // 2. Polymorphic base match + suffix disambiguation
      if (this._isPolymorphic(el)) {
        const basePath = el.id.slice(0, -3); // remove [x]
        const typeMatch = el.type?.find(t => {
          return `${basePath}${initCap(t.code)}` === searchPath;
        });
        if (typeMatch) {
          return { element: el, narrowedType: typeMatch };
        }

        // 3. Bracket form (e.g. value[valueString] → valueString → value[x] narrowed)
        const bracketMatch = searchPath.match(/^(.+)\[([^\]]+)\]$/);
        if (bracketMatch) {
          const [, outer, inner] = bracketMatch;
          if (el.id === `${outer}[x]`) {
          // inner could be a type (e.g. string) or a disambiguator (e.g. valueString)
            const directCodeMatch = el.type?.find(t => t.code === inner);
            const aliasMatch = el.type?.find(t => `${outer}${initCap(t.code)}` === inner);
            const match = directCodeMatch ?? aliasMatch;
            if (match) return { element: el, narrowedType: match };
          }
        }
      }
    }

    return { element: undefined };
  }

  private async _tryResolveSnapshot(id: string): Promise<string | null> {
    try {
      await this.fsg.getSnapshot(id);
      return id;
    } catch {
      return null;
    }
  }
}
