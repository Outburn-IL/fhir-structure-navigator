import { describe, it, expect, beforeAll } from 'vitest';
import { FhirSnapshotGenerator } from 'fhir-snapshot-generator';
import { FhirStructureNavigator } from '.';

const context = ['hl7.fhir.us.core@6.1.0', 'fsg.test.pkg@0.1.0'];

let fetcher: FhirStructureNavigator;

beforeAll(async () => {
  const fsg = await FhirSnapshotGenerator.create({
    context,
    cachePath: './test/.test-cache',
    fhirVersion: '4.0.1',
    cacheMode: 'lazy'
  });
  fetcher = new FhirStructureNavigator(fsg);
}, 300000); // 5 minutes timeout for setup

describe('ElementFetcher', () => {
  it('resolves a normal element path', async () => {
    const el = await fetcher.getElement('us-core-patient', 'gender');
    expect(el.path).toBe('Patient.gender');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-patient');
  });

  it('resolves a deep element path', async () => {
    const el = await fetcher.getElement('us-core-patient', 'identifier.assigner.identifier.assigner.display');
    expect(el.path).toBe('Reference.display');
    expect(el.__fromDefinition).toContain('StructureDefinition/Reference');
  });

  it('resolves a polymorphic type using shortcut form (valueString)', async () => {
    const el = await fetcher.getElement('Extension', 'valueString');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('string');
  });

  it('resolves a polymorphic type using shortcut form (valueQuantity)', async () => {
    const el = await fetcher.getElement('Extension', 'valueQuantity');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('Quantity');
  });

  it('resolves a real polymorphic slice using shortcut form (valueString)', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'valueString');
    expect(el.id).toBe('Extension.value[x]:valueString');
    expect(el.__fromDefinition).toBe(profile);
  });

  it('resolves a polymorphic head when real slices exist on other types', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'valueBoolean');
    expect(el.id).toBe('Extension.value[x]');
    expect(el.__fromDefinition).toBe(profile);
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('boolean');
  });

  it('resolves a polymorphic type using short bracket syntax (value[string])', async () => {
    const el = await fetcher.getElement('Extension', 'value[string]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('string');
  });

  it('resolves a real polymorphic slice using short bracket syntax (value[string])', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'value[string]');
    expect(el.id).toBe('Extension.value[x]:valueString');
    expect(el.__fromDefinition).toBe(profile);
  });

  it('resolves a real polymorphic slice using long bracket syntax (value[valueString])', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'value[valueString]');
    expect(el.id).toBe('Extension.value[x]:valueString');
    expect(el.__fromDefinition).toBe(profile);
  });

  it('resolves a polymorphic type using short bracket syntax (value[CodeableConcept])', async () => {
    const el = await fetcher.getElement('Extension', 'value[CodeableConcept]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('CodeableConcept');
  });

  // TODO: support this feature
  it.skip('resolves a polymorphic type using long bracket syntax (value[valueString])', async () => {
    const el = await fetcher.getElement('Extension', 'value[valueString]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('string');
  });

  it.skip('resolves a polymorphic type using long bracket syntax (value[valueCodeableConcept])', async () => {
    const el = await fetcher.getElement('Extension', 'value[valueCodeableConcept]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('CodeableConcept');
  });

  it('resolves a child of polymorphic using shortcut form (valueQuantity.value)', async () => {
    const el = await fetcher.getElement('Extension', 'valueQuantity.value');
    expect(el.path).toBe('Quantity.value');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('decimal');
  });

  it('resolves a child of polymorphic using bracket syntax (value[Quantity].value)', async () => {
    const el = await fetcher.getElement('Extension', 'value[Quantity].value');
    expect(el.path).toBe('Quantity.value');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('decimal');
  });

  it('resolves a deep decendant of polymorphic using shortcut form (valueReference.identifier.assigner.identifier.system)', async () => {
    const el = await fetcher.getElement('Extension', 'valueReference.identifier.assigner.identifier.system');
    expect(el.path).toBe('Identifier.system');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('uri');
  });

  it('resolves a deep decendant of polymorphic using bracket form (value[Reference].identifier.assigner.identifier.system)', async () => {
    const el = await fetcher.getElement('Extension', 'value[Reference].identifier.assigner.identifier.system');
    expect(el.path).toBe('Identifier.system');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('uri');
  });

  it('resolves a slice of extension', async () => {
    const el = await fetcher.getElement('us-core-patient', 'extension[race]');
    expect(el.id).toContain(':race');
    expect(el.path).toBe('Patient.extension');
  });

  it('resolves a child of a slice of extension', async () => {
    const el = await fetcher.getElement('us-core-patient', 'extension[race].url');
    expect(el.path).toBe('Extension.url');
    expect(el.fixedUri).toBe('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
  });

  it('resolves a rebased path (identifier.value.extension)', async () => {
    const el = await fetcher.getElement('us-core-patient', 'identifier.value.extension');
    expect(el.path).toBe('string.extension');
    expect(el.__fromDefinition).toContain('StructureDefinition/string');
  });

  it('resolves a virtual slice as profile id', async () => {
    const el = await fetcher.getElement('Patient', 'extension[us-core-race]');
    expect(el.path).toBe('Extension');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
  });

  it('resolves a virtual slice as profile url', async () => {
    const el = await fetcher.getElement('Patient', 'extension[http://hl7.org/fhir/us/core/StructureDefinition/us-core-race]');
    expect(el.path).toBe('Extension');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
  });

  it('resolves a child of a virtual slice (profile id)', async () => {
    const el = await fetcher.getElement('Patient', 'extension[us-core-race].url');
    expect(el.path).toBe('Extension.url');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
    expect(el.fixedUri).toBe('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race');
  });

  it('resolves a child of a virtual slice (profile url)', async () => {
    const el = await fetcher.getElement('Patient', 'extension[http://hl7.org/fhir/us/core/StructureDefinition/us-core-race].url');
    expect(el.path).toBe('Extension.url');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
    expect(el.fixedUri).toBe('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race');
  });

  it('gets children of root', async () => {
    const children = await fetcher.getChildren('us-core-patient', '.');
    expect(children.some(c => c.path === 'Patient.identifier')).toBe(true);
  });

  it('gets children of a resolved path', async () => {
    const children = await fetcher.getChildren('us-core-patient', 'identifier');
    expect(children.some(c => c.path === 'Patient.identifier.use')).toBe(true);
  });

  it('gets children of a deep element path', async () => {
    const children = await fetcher.getChildren('us-core-patient', 'identifier.assigner.identifier.assigner.display');
    expect(children.some(c => c.path === 'string.extension')).toBe(true);
  });

  it('gets rebased children (e.g. identifier.value children from string)', async () => {
    const children = await fetcher.getChildren('Patient', 'identifier.value');
    const childPaths = children.map(c => c.path);
    expect(childPaths).toContain('string.extension');
    expect(childPaths).toContain('string.id');
  });

  it('gets chidren of a polymorphic type using shortcut form (valueString)', async () => {
    const children = await fetcher.getChildren('Extension', 'valueString');
    expect(children.some(c => c.path === 'string.extension')).toBe(true);
  });

  // TODO:
  // * allow polymorphic disambiguation using a profile, e.g value[ILCoreAddress]
  // * handle long bracket forms like value[valueString] and value[valueCodeableConcept]
  // * enforce type match when using a virtual slice, e.g contact[ILCoreAddress] is illegal (ContactPoint <> Address)
  // * enforce extension scope, e.g. address.extension[us-core-race] is illegal (Address <> Patient)
  // * resolve reference snapshots in the correct context (profile context vs global context)
  // * resolve base types in the correct FHIR version context
  // * add more deeply nested tests for all variations of polymorhics and slices, including combinations e.g value[Reference].extension[id].valueString

});
