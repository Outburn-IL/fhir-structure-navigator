# @outburn/structure-navigator

Navigate and resolve FHIR `ElementDefinition`s from `StructureDefinition` snapshots using FSH-like paths.

This library wraps a `fhir-snapshot-generator` instance and adds:

- FSH-style path traversal (`a.b.c`)
- Slice selection (`extension[race]`)
- Polymorphic resolution shortcuts (`valueString`, `value[Quantity]`, `value[x]`)
- Virtual slice / profile rebasing (`extension[us-core-race]`, `value[SimpleQuantity]`)
- `contentReference` rebasing (e.g. `Bundle.entry.link.url`)

## Installation

This package has peer dependencies:

```sh
npm i @outburn/structure-navigator fhir-snapshot-generator fhir-package-explorer @outburn/types
```

## Quickstart

Create a `FhirPackageExplorer`, then a `FhirSnapshotGenerator`, then a `FhirStructureNavigator`.

```ts
import { FhirSnapshotGenerator } from 'fhir-snapshot-generator';
import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FhirStructureNavigator } from '@outburn/structure-navigator';

const fpe = await FhirPackageExplorer.create({
	context: ['hl7.fhir.r4.core@4.0.1'],
	cachePath: './.fhir-cache',
	fhirVersion: '4.0.1'
});

const fsg = await FhirSnapshotGenerator.create({
	fhirVersion: '4.0.1',
	cacheMode: 'lazy',
	fpe
});

const nav = new FhirStructureNavigator(fsg);

const el = await nav.getElement('Patient', 'identifier.assigner.display');
console.log(el.path); // "Reference.display"

const children = await nav.getChildren('Patient', 'identifier');
console.log(children.map(c => c.path));
```

## API

### `new FhirStructureNavigator(fsg, logger?, cacheOptions?)`

- `fsg`: a `FhirSnapshotGenerator`.
- `logger` (optional): `{ debug, info, warn, error }`.
- `cacheOptions` (optional): External cache implementations for DI (see Cache Architecture below).

### Cache Architecture

The navigator implements a two-tier caching strategy:

1. **Inner LRU Layer**: Fast, in-memory LRU cache for ultra-hot entries
2. **External Layer** (optional): Pluggable external cache (e.g., LMDB) via dependency injection

#### Cache Types

Four independent cache interfaces can be injected:

```ts
interface NavigatorCacheOptions {
  snapshotCache?: ICache<any>;
  typeMetaCache?: ICache<FileIndexEntryWithPkg>;
  elementCache?: ICache<EnrichedElementDefinition>;
  childrenCache?: ICache<EnrichedElementDefinition[]>;
  lruSizes?: {
    snapshot?: number;
    typeMeta?: number;
    element?: number;
    children?: number;
  };
}
```

#### Cache Interface

The `ICache<T>` interface supports array-based keys for LMDB compatibility:

```ts
interface ICache<T> {
  get(key: (string | number)[]): Promise<T | undefined> | T | undefined;
  set(key: (string | number)[], value: T): Promise<void> | void;
  has(key: (string | number)[]): Promise<boolean> | boolean;
  delete(key: (string | number)[]): Promise<boolean> | boolean;
  clear(): Promise<void> | void;
}
```

Keys are structured as arrays to avoid string concatenation/splitting overhead in LMDB implementations.

#### LRU Sizing

Each cache always has an in-memory LRU hot layer, regardless of whether an external cache is provided. Providing an external cache does **not** change the in-memory LRU sizing; it simply adds an optional "cold" layer that entries can be promoted from.

Default LRU sizes:

| Cache Type | Default LRU size |
|------------|------------------|
| Snapshot   | 100              |
| TypeMeta   | 500              |
| Element    | 2000             |
| Children   | 500              |

You can override any of these (entry counts) via `cacheOptions.lruSizes`:

```ts
const nav = new FhirStructureNavigator(fsg, logger, {
  lruSizes: {
    // keep more element path resolutions hot in memory
    element: 5000,

    // keep fewer snapshots hot (lower memory footprint)
    snapshot: 50
  }
});
```

#### Package Context Namespacing

Element and children caches include a package context namespace (from `FPE.getNormalizedRootPackages()`) in their keys. This ensures safe sharing of external caches between navigator instances with different package contexts.

The snapshot and typeMeta caches already include package information in their keys, so no additional namespacing is needed.

#### Example: Custom Cache Implementation

```ts
import { ICache } from '@outburn/structure-navigator';

class MyLMDBCache<T> implements ICache<T> {
  async get(key: (string | number)[]): Promise<T | undefined> {
    // Use key array directly with LMDB range queries
    return await this.db.get(key);
  }
  
  async set(key: (string | number)[], value: T): Promise<void> {
    await this.db.put(key, value);
  }
  
  // ... implement other methods
}

const nav = new FhirStructureNavigator(fsg, logger, {
  snapshotCache: new MyLMDBCache(),
  elementCache: new MyLMDBCache(),
  childrenCache: new MyLMDBCache()
});
```

### `getElement(snapshotId, fshPath)`

Resolves a single element using an FSH-like path.

- `snapshotId`: either
	- a string (StructureDefinition id or canonical url), e.g. `"us-core-patient"`, `"Patient"`, `"http://.../StructureDefinition/..."`, or
	- a `FileIndexEntryWithPkg` (package id/version + filename), as used by `fhir-package-explorer`.
- `fshPath`: FSH-like path string (see below).

Returns an `EnrichedElementDefinition`.

### `getChildren(snapshotId, fshPath)`

Returns the *direct* children of the resolved element.

- Use `"."` to get children of the root element.

### `getFsg()`, `getFpe()`, `getLogger()`

Access the underlying snapshot generator, package explorer, and logger.

## Returned element shape

The navigator enriches each returned element with metadata useful for tooling:

- `__fromDefinition`: canonical URL of the StructureDefinition the element ultimately came from
- `__corePackage`: the “core” package identifier used for resolving base types
- `__packageId` / `__packageVersion`: package that contributed the resolved snapshot
- `__name`: computed “FSH-ish” name(s)
	- For polymorphic `value[x]`, `__name` is inferred like `valueString`, `valueQuantity`, etc.
	- For `contentReference` elements, `__name` is inferred from the reference target.
- `type[].__kind`: best-effort kind info (`primitive-type`, `complex-type`, `resource`, `logical`, `system`, …)

Note: the navigator also strips a set of verbose fields (like `definition`, `comment`, `mapping`, …) from elements when caching snapshots.

## Path syntax (FSH-like)

Paths are dot-separated segments. Dots inside `[...]` are not treated as separators.

### 1) Normal element navigation

```ts
await nav.getElement('us-core-patient', 'gender');
await nav.getElement('Patient', 'address.city');
```

### 2) Deep navigation across types (rebasing)

If an element’s type points to another StructureDefinition (base type or profile), traversal “rebases” into that snapshot.

Examples:

- `identifier.value.extension` rebases from `Identifier.value` (string) into `StructureDefinition/string`.
- `identifier.assigner.identifier.assigner.display` rebases through `Reference`/`Identifier` back and forth.

```ts
const el = await nav.getElement('us-core-patient', 'identifier.value.extension');
console.log(el.path); // "string.extension"
```

### 3) Slices: `element[sliceName]`

FSH slice selection is supported:

```ts
await nav.getElement('us-core-patient', 'extension[race]');
await nav.getElement('us-core-patient', 'extension[race].url');
```

### 4) Polymorphic elements (`[x]`)

For polymorphic elements like `Extension.value[x]`, you can select a type in several ways.

#### a) Shortcut suffix form: `valueString`, `valueQuantity`, …

```ts
const el = await nav.getElement('Extension', 'valueString');
// resolves Extension.value[x] and narrows type to string
```

#### b) Bracket type form: `value[string]`, `value[Quantity]`, `value[CodeableConcept]`

```ts
await nav.getElement('Extension', 'value[string]');
await nav.getElement('Extension', 'value[Quantity]');
await nav.getElement('Extension', 'value[CodeableConcept]');
```

#### c) Base polymorphic element: `value[x]`

```ts
await nav.getElement('Extension', 'value[x]'); // returns the polymorphic head with all possible types
```

#### d) Traverse into a selected polymorphic type

```ts
await nav.getElement('Extension', 'valueQuantity.value');
await nav.getElement('Extension', 'value[Quantity].value');
await nav.getElement('Extension', 'valueReference.identifier.system');
```

### 5) Real polymorphic slices

Some profiles define real slices on polymorphics, e.g. `Extension.value[x]:valueString`.
The navigator will return the real slice element when it exists:

```ts
const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
await nav.getElement(profile, 'valueString');
await nav.getElement(profile, 'value[string]');
await nav.getElement(profile, 'value[valueString]');
```

If a slice exists for some types but not others, selecting a non-sliced type still works and returns the narrowed head.

### 6) Virtual slices (profile rebasing): `element[SomeProfile]`

If the text inside brackets is not a real slice name, the navigator will try to resolve it as a `StructureDefinition` (by id in core package context, or by canonical URL).

If it resolves, it is treated as a “virtual slice” and traversal continues in that profile snapshot.

```ts
await nav.getElement('Patient', 'extension[us-core-race]');
await nav.getElement('Patient', 'extension[http://hl7.org/fhir/us/core/StructureDefinition/us-core-race]');
await nav.getElement('Patient', 'extension[us-core-race].url');
```

Virtual slicing is also supported on polymorphics when the profile’s base type is allowed:

```ts
await nav.getElement('Observation', 'value[SimpleQuantity]');
await nav.getElement('Observation', 'value[SimpleQuantity].value');
```

### 7) `contentReference` rebasing

FHIR allows elements to reference other elements via `contentReference` (e.g. `Bundle.entry.link` has `#Bundle.link`).
When encountered, traversal rebases through the referenced element and continues.

```ts
await nav.getElement('Bundle', 'entry.link');
await nav.getElement('Bundle', 'entry.link.url');
await nav.getElement('Questionnaire', 'item.item.item.item.linkId');
```

## Getting children

Use `getChildren()` to fetch direct children.

```ts
// Root children
const rootChildren = await nav.getChildren('us-core-patient', '.');

// Children of a resolved path
const idChildren = await nav.getChildren('us-core-patient', 'identifier');

// Children also work through rebasing/polymorphics/slices/contentReference
await nav.getChildren('Extension', 'valueString');
await nav.getChildren('Patient', 'extension[us-core-race]');
await nav.getChildren('Bundle', 'entry.link.extension');
```

## Errors and gotchas

- If a segment can’t be found, `getElement()` throws.
- If you use a virtual slice/profile whose base type is not allowed by the parent element’s `type[]`, it throws with an “Expected one of …” message.
	- Example: `Observation.value[bp]` throws because the resolved profile type is not permitted.
- `getChildren()` throws for choice-type elements that still have multiple possible types (because children are ambiguous).
- `getChildren('.', ...)` is supported only via `fshPath = "."` (root).

## License

Apache-2.0 (see LICENSE).