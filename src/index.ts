/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-structure-navigator
 */

import { FhirSnapshotGenerator, ElementDefinition } from 'fhir-snapshot-generator';

export interface EnrichedElementDefinition extends ElementDefinition {
  __fromDefinition: string;
}

const initCap = (str: string): string => {
  return str.charAt(0).toUpperCase() + str.slice(1);
};

const splitFshPath = (path: string): string[] => {
  const segments: string[] = [];
  let current = '';
  let inBrackets = false;

  for (const char of path) {
    if (char === '[') inBrackets = true;
    if (char === ']') inBrackets = false;

    if (char === '.' && !inBrackets) {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current) segments.push(current);
  return segments;
};

export class FhirStructureNavigator {
  private fsg: FhirSnapshotGenerator;
  
  constructor(fsg: FhirSnapshotGenerator) {
    this.fsg = fsg;
  }

  async getElement(
    snapshotId: string,
    fshPath: string
  ): Promise<EnrichedElementDefinition> {
    const segments = splitFshPath(fshPath);
    return await this._resolvePath(snapshotId, segments);
  }

  async getChildren(
    snapshotId: string,
    fshPath: string
  ): Promise<EnrichedElementDefinition[]> {
    const segments = fshPath === '.' ? [] : splitFshPath(fshPath);
    const resolved = await this._resolvePath(snapshotId, segments);
    const parentId = resolved.path!;
    const snapshotUrl = resolved.__fromDefinition;

    const snapshot = await this.fsg.getSnapshot(snapshotUrl);
    const elements = snapshot.snapshot.element;

    const directChildren = elements.filter(el => {
      if (!el.id?.startsWith(`${parentId}.`)) return false;
      const remainder = el.id.slice(parentId.length + 1);
      return remainder.length > 0 && !remainder.includes('.');
    });

    if (directChildren.length > 0) {
      return directChildren.map(el => ({
        ...el,
        __fromDefinition: snapshotUrl
      }));
    }

    // Check for contentReference
    if (resolved.contentReference) {
      const refPath = resolved.contentReference.replace(/^#/, '');
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
  }


  private async _resolvePath(
    snapshotId: string,
    pathSegments: string[]
  ): Promise<EnrichedElementDefinition> {
    const snapshot = await this.fsg.getSnapshot(snapshotId);
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
        currentElement = { ...currentElement, type: [narrowedType] };
      }

      // Handle rebasing by contentReference
      if (!currentElement && previousElement?.contentReference) {
        const refPath = previousElement.contentReference.replace(/^#/, '');
        const baseDef = snapshot.type;
        const rebasedPath = [...refPath.split('.'), ...pathSegments.slice(i)];
        return await this._resolvePath(baseDef, rebasedPath);
      }

      // If still not found, try rebasing via base type
      if (!currentElement && previousElement && previousElement?.type?.length === 1) {
        const typeObj = previousElement.type[0];
        const baseType = Array.isArray(typeObj.profile) ? typeObj.profile[0] : typeObj.code;
        if (baseType) {
          const rebasedPath = pathSegments.slice(i);
          return await this._resolvePath(baseType, rebasedPath);
        }
      }

      if (!currentElement) {
        throw new Error(`"${segment}" not found under "${previousElement?.path}" in structure "${snapshotId}"`);
      }

      // Handle slice syntax
      if (slice) {
        const sliceId = `${searchPath}:${slice}`;
        const sliceMatch = elements.find(el => el.id === sliceId);

        if (sliceMatch) {
          currentElement = sliceMatch;
        } else {
          if (this._isPolymorphic(currentElement)) {
            const matchedType = currentElement.type?.find(
              t => t.code?.toLowerCase() === slice.toLowerCase()
            );
            if (matchedType) {
              currentElement = {
                ...currentElement,
                type: [matchedType]
              };
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
