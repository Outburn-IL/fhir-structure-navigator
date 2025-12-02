import { describe, it, expect, beforeAll } from 'vitest';
import { FhirSnapshotGenerator } from 'fhir-snapshot-generator';
import { FhirStructureNavigator } from '@outburn/structure-navigator';
import { FileIndexEntryWithPkg } from 'fhir-package-explorer';

const context = ['hl7.fhir.us.core@6.1.0', 'fsg.test.pkg@0.1.0', 'il.core.fhir.r4#0.17.0'];

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
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a deep element path', async () => {
    const el = await fetcher.getElement({
      __packageId: 'hl7.fhir.us.core',
      __packageVersion: '6.1.0',
      'filename': 'StructureDefinition-us-core-patient.json'
    } as FileIndexEntryWithPkg, 'identifier.assigner.identifier.assigner.display');
    expect(el.path).toBe('Reference.display');
    expect(el.__fromDefinition).toContain('StructureDefinition/Reference');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a polymorphic type using shortcut form (valueString)', async () => {
    const el = await fetcher.getElement('Extension', 'valueString');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueString']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('string');
  });

  it('resolves a polymorphic type using shortcut form (valueQuantity)', async () => {
    const el = await fetcher.getElement('Extension', 'valueQuantity');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueQuantity']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('Quantity');
  });

  it('resolves a polymorphic type using value[x] syntax', async () => {
    const el = await fetcher.getElement('Extension', 'value[x]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBeGreaterThan(1); // Should return all possible types
    expect(el.__name).toBeDefined();
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves complex path with value[x] syntax (address.extension[language].value[x])', async () => {
    const el = await fetcher.getElement('Patient', 'address.extension[language].value[x]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1); // language extension has a single type (code)
    expect(el.__name).toBeDefined();
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('throws on polymorphic type mismatch using a base type as virtual slice (value[canonical])', async () => {
    await expect(
      fetcher.getElement('Observation', 'value[canonical]')
    ).rejects.toThrow(/which is not allowed here./i);
  });

  it('throws on polymorphic type mismatch using a profile as virtual slice (value[bp])', async () => {
    await expect(
      fetcher.getElement('Observation', 'value[bp]')
    ).rejects.toThrow(/which is not allowed here./i);
  });

  it('throws on type mismatch when using a virtual slice (address[bp])', async () => {
    await expect(
      fetcher.getElement('Patient', 'address[bp]')
    ).rejects.toThrow(/which is not allowed here./i);
  });

  it('resolves a real polymorphic slice using shortcut form (valueString)', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'valueString');
    expect(el.id).toBe('Extension.value[x]:valueString');
    expect(el.__fromDefinition).toBe(profile);
    expect(el.__name).toEqual(['valueString']);
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a polymorphic head when real slices exist on other types', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'valueBoolean');
    expect(el.id).toBe('Extension.value[x]');
    expect(el.__fromDefinition).toBe(profile);
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueBoolean']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('boolean');
  });

  it('resolves a polymorphic type using short bracket syntax (value[string])', async () => {
    const el = await fetcher.getElement('Extension', 'value[string]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueString']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('string');
  });

  it('resolves a real polymorphic slice using short bracket syntax (value[string])', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'value[string]');
    expect(el.id).toBe('Extension.value[x]:valueString');
    expect(el.__fromDefinition).toBe(profile);
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueString']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a real polymorphic slice using long bracket syntax (value[valueString])', async () => {
    const profile = 'http://example.org/StructureDefinition/ExtensionWithPolySlices';
    const el = await fetcher.getElement(profile, 'value[valueString]');
    expect(el.id).toBe('Extension.value[x]:valueString');
    expect(el.__fromDefinition).toBe(profile);
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueString']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a polymorphic type using short bracket syntax (value[CodeableConcept])', async () => {
    const el = await fetcher.getElement('Extension', 'value[CodeableConcept]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueCodeableConcept']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('CodeableConcept');
  });

  it.skip('resolves a polymorphic type using long bracket syntax (value[valueString])', async () => {
    const el = await fetcher.getElement('Extension', 'value[valueString]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueString']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('string');
  });

  it.skip('resolves a polymorphic type using long bracket syntax (value[valueCodeableConcept])', async () => {
    const el = await fetcher.getElement('Extension', 'value[valueCodeableConcept]');
    expect(el.path).toBe('Extension.value[x]');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueCodeableConcept']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('CodeableConcept');
  });

  it('resolves a profile as virtual slice on polymorphic (value[SimpleQuantity])', async () => {
    // This is currently skipped because currently the root element of the target profile is returned
    // and that might not be a desired behavior since the element definition is missing critical information
    // like __name (since the name of the element can only be inferred by a path of more than one segment)
    const el = await fetcher.getElement('Observation', 'value[SimpleQuantity]');
    expect(el.path).toBe('Quantity');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['valueQuantity']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('Quantity');
  });

  it('resolves a child of a profile as virtual slice on polymorphic (value[SimpleQuantity].value)', async () => {
    const el = await fetcher.getElement('Observation', 'value[SimpleQuantity].value');
    expect(el.path).toBe('Quantity.value');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['value']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('decimal');
  });

  it('resolves a child of polymorphic using shortcut form (valueQuantity.value)', async () => {
    const el = await fetcher.getElement('Extension', 'valueQuantity.value');
    expect(el.path).toBe('Quantity.value');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['value']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('decimal');
  });

  it('resolves a child of polymorphic using bracket syntax (value[Quantity].value)', async () => {
    const el = await fetcher.getElement('Extension', 'value[Quantity].value');
    expect(el.path).toBe('Quantity.value');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['value']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('decimal');
  });

  it('resolves a deep descendant of polymorphic using shortcut form (valueReference.identifier.assigner.identifier.system)', async () => {
    const el = await fetcher.getElement('Extension', 'valueReference.identifier.assigner.identifier.system');
    expect(el.path).toBe('Identifier.system');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['system']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('uri');
  });

  it('resolves a deep descendant of polymorphic using bracket form (value[Reference].identifier.assigner.identifier.system)', async () => {
    const el = await fetcher.getElement('Extension', 'value[Reference].identifier.assigner.identifier.system');
    expect(el.path).toBe('Identifier.system');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['system']);
    expect(el.type?.[0].__kind).toBeDefined();
    expect(el.type?.[0].code).toBe('uri');
  });

  it('resolves a slice of extension', async () => {
    const el = await fetcher.getElement('us-core-patient', 'extension[race]');
    expect(el.id).toContain(':race');
    expect(el.path).toBe('Patient.extension');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['extension']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a child of a slice of extension', async () => {
    const el = await fetcher.getElement('us-core-patient', 'extension[race].url');
    expect(el.path).toBe('Extension.url');
    expect(el.fixedUri).toBe('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['url']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a rebased path (identifier.value.extension)', async () => {
    const el = await fetcher.getElement('us-core-patient', 'identifier.value.extension');
    expect(el.path).toBe('string.extension');
    expect(el.__fromDefinition).toContain('StructureDefinition/string');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['extension']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a virtual slice as profile id', async () => {
    const el = await fetcher.getElement('Patient', 'extension[us-core-race]');
    expect(el.path).toBe('Extension');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['extension']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a virtual slice as profile url', async () => {
    const el = await fetcher.getElement('Patient', 'extension[http://hl7.org/fhir/us/core/StructureDefinition/us-core-race]');
    expect(el.path).toBe('Extension');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['extension']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a child of a virtual slice (profile id)', async () => {
    const el = await fetcher.getElement('Patient', 'extension[us-core-race].url');
    expect(el.path).toBe('Extension.url');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
    expect(el.fixedUri).toBe('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['url']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a child of a virtual slice (profile url)', async () => {
    const el = await fetcher.getElement('Patient', 'extension[http://hl7.org/fhir/us/core/StructureDefinition/us-core-race].url');
    expect(el.path).toBe('Extension.url');
    expect(el.__fromDefinition).toContain('StructureDefinition/us-core-race');
    expect(el.fixedUri).toBe('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race');
    expect(el.type?.length).toBe(1);
    expect(el.__name).toEqual(['url']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves an element with contentReference and ensures __name is set (Bundle.entry.link)', async () => {
    const el = await fetcher.getElement('Bundle', 'entry.link');
    // Bundle.entry.link has contentReference="#Bundle.link"
    expect(el.contentReference).toBe('#Bundle.link');
    expect(el.__fromDefinition).toContain('StructureDefinition/Bundle');
    expect(el.__name).toEqual(['link']);
    expect(el.__name).toBeDefined();
  });

  it('resolves an element with recursive contentReference and ensures __name is set (Questionnaire.item.item.item)', async () => {
    const el = await fetcher.getElement('Questionnaire', 'item.item.item');
    // Questionnaire.item has contentReference="#Questionnaire.item", so deep nesting should resolve properly
    expect(el.contentReference).toBe('#Questionnaire.item');
    expect(el.__fromDefinition).toContain('StructureDefinition/Questionnaire');
    expect(el.__name).toEqual(['item']);
    expect(el.__name).toBeDefined();
  });

  it('resolves an element through contentReference (Bundle.entry.link.url)', async () => {
    const el = await fetcher.getElement('Bundle', 'entry.link.url');
    // Bundle.entry.link has contentReference="#Bundle.link", so this should resolve to Bundle.link.url
    expect(el.path).toBe('Bundle.link.url');
    expect(el.__fromDefinition).toContain('StructureDefinition/Bundle');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('uri');
    expect(el.__name).toEqual(['url']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves a deep element through contentReference (Bundle.entry.link.extension.url)', async () => {
    const el = await fetcher.getElement('Bundle', 'entry.link.extension.url');
    // This should resolve through contentReference and then traverse to extension.url
    expect(el.path).toBe('Extension.url');
    expect(el.__fromDefinition).toContain('StructureDefinition/Extension');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('http://hl7.org/fhirpath/System.String');
    expect(el.__name).toEqual(['url']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('resolves an element through nested contentReference (Questionnaire.item.item.item.item.item.linkId)', async () => {
    const el = await fetcher.getElement('Questionnaire', 'item.item.item.item.item.linkId');
    // Questionnaire.item has contentReference="#Questionnaire.item", so deep nesting should work
    expect(el.path).toBe('Questionnaire.item.linkId');
    expect(el.__fromDefinition).toContain('StructureDefinition/Questionnaire');
    expect(el.type?.length).toBe(1);
    expect(el.type?.[0].code).toBe('string');
    expect(el.__name).toEqual(['linkId']);
    expect(el.type?.[0].__kind).toBeDefined();
  });

  it('gets children of root', async () => {
    const children = await fetcher.getChildren('us-core-patient', '.');
    expect(children.some(c => c.path === 'Patient.identifier')).toBe(true);
    children.forEach(c => {
      expect(c.type).toBeDefined();
      expect(c.__name).toBeDefined();
      expect(c.__fromDefinition).toBeDefined();
      c.type?.forEach(t => {
        expect(t.__kind).toBeDefined();
      });
    });
  });

  it('gets children of a resolved path', async () => {
    const children = await fetcher.getChildren('us-core-patient', 'identifier');
    expect(children.some(c => c.path === 'Patient.identifier.use')).toBe(true);
    children.forEach(c => {
      expect(c.type).toBeDefined();
      expect(c.__name).toBeDefined();
      expect(c.__fromDefinition).toBeDefined();
      c.type?.forEach(t => {
        expect(t.__kind).toBeDefined();
      });
    });
  });

  it('gets children of a deep element path', async () => {
    const children = await fetcher.getChildren({
      __packageId: 'hl7.fhir.us.core',
      __packageVersion: '6.1.0',
      'filename': 'StructureDefinition-us-core-patient.json'
    } as FileIndexEntryWithPkg, 'identifier.assigner.identifier.assigner.display');
    expect(children.some(c => c.path === 'string.extension')).toBe(true);
    children.forEach(c => {
      expect(c.type).toBeDefined();
      expect(c.__name).toBeDefined();
      expect(c.__fromDefinition).toBeDefined();
      c.type?.forEach(t => {
        expect(t.__kind).toBeDefined();
      });
    });
  });

  it('gets rebased children (e.g. identifier.value children from string)', async () => {
    const children = await fetcher.getChildren({
      filename: 'StructureDefinition-Patient.json',
      __packageId: 'hl7.fhir.r4.core',
      __packageVersion: '4.0.1'
    } as FileIndexEntryWithPkg, 'identifier.value');
    const childPaths = children.map(c => c.path);
    expect(childPaths).toContain('string.extension');
    expect(childPaths).toContain('string.id');
    children.forEach(c => {
      expect(c.type).toBeDefined();
      expect(c.__fromDefinition).toBeDefined();
      expect(c.__name).toBeDefined();
      c.type?.forEach(t => {
        expect(t.__kind).toBeDefined();
      });
    });
  });

  it('gets chidren of a polymorphic type using shortcut form (valueString)', async () => {
    const children = await fetcher.getChildren('Extension', 'valueString');
    expect(children.some(c => c.path === 'string.extension')).toBe(true);
    children.forEach(c => {
      expect(c.type).toBeDefined();
      expect(c.__name).toBeDefined();
      expect(c.__fromDefinition).toBeDefined();
      c.type?.forEach(t => {
        expect(t.__kind).toBeDefined();
      });
    });
  });

  it('gets children of a virtual slice referencing an extension definition', async () => {
    const children = await fetcher.getChildren('Patient', 'extension[ext-il-hmo]');
    expect(children.some(c => c.id === 'Extension.url')).toBe(true);
    // ensure the url element has the correct fixed value
    const urlElement = children.find(c => c.id === 'Extension.url');
    expect(urlElement?.fixedUri).toBe('http://fhir.health.gov.il/StructureDefinition/ext-il-hmo');
    expect(urlElement?.__fromDefinition).toContain('StructureDefinition/ext-il-hmo');
  });

  it('gets children of a virtual slice referencing an extension definition', async () => {
    const children = await fetcher.getChildren('Patient', 'extension[HearingLossDisability]');
    expect(children.some(c => c.id === 'Extension.url')).toBe(true);
    // ensure the url element has the correct fixed value
    const urlElement = children.find(c => c.id === 'Extension.url');
    expect(urlElement?.fixedUri).toBe('http://hl7.org/fhir/StructureDefinition/patient-disability');
    expect(urlElement?.__fromDefinition).toContain('StructureDefinition/ext-hearing-loss');
  });

  it('gets children of a child of a virtual slice referencing an extension definition', async () => {
    const children = await fetcher.getChildren('Patient', 'extension[HearingLossDisability].value');
    expect(children.some(c => c.id === 'Extension.value[x].coding')).toBe(true);
    // ensure the url element has the correct fixed value
    const urlElement = children.find(c => c.id === 'Extension.value[x].coding');
    expect(urlElement?.min).toBe(1);
    expect(urlElement?.__fromDefinition).toContain('StructureDefinition/ext-hearing-loss');
  });

  it('gets children of an element with contentReference (Bundle.entry.link)', async () => {
    const children = await fetcher.getChildren('Bundle', 'entry.link');
    expect(children.length).toBeGreaterThan(0);
    // Bundle.entry.link has contentReference="#Bundle.link", so children should be from Bundle.link
    expect(children.some(c => c.path === 'Bundle.link.relation')).toBe(true);
    expect(children.some(c => c.path === 'Bundle.link.url')).toBe(true);
    children.forEach(c => {
      expect(c.type).toBeDefined();
      expect(c.__name).toBeDefined();
      expect(c.__fromDefinition).toBeDefined();
      c.type?.forEach(t => {
        expect(t.__kind).toBeDefined();
      });
    });
  });

  it('gets children of a deep path through contentReference (Bundle.entry.link.extension)', async () => {
    const children = await fetcher.getChildren('Bundle', 'entry.link.extension');
    expect(children.length).toBeGreaterThan(0);
    // This should resolve through contentReference and then get extension children
    expect(children.some(c => c.path === 'Extension.url')).toBe(true);
    expect(children.some(c => c.path === 'Extension.value[x]')).toBe(true);
    children.forEach(c => {
      expect(c.type).toBeDefined();
      expect(c.__name).toBeDefined();
      expect(c.__fromDefinition).toBeDefined();
      c.type?.forEach(t => {
        expect(t.__kind).toBeDefined();
      });
    });
  });

  it('gets children of nested contentReference elements (Questionnaire.item.item.item.item.item)', async () => {
    const children = await fetcher.getChildren('Questionnaire', 'item.item.item.item.item');
    expect(children.length).toBeGreaterThan(0);
    
    // Questionnaire.item has contentReference="#Questionnaire.item", so deep nesting should work
    expect(children.some(c => c.path === 'Questionnaire.item.linkId')).toBe(true);
    expect(children.some(c => c.path === 'Questionnaire.item.text')).toBe(true);
    expect(children.some(c => c.path === 'Questionnaire.item.type')).toBe(true);
    children.forEach(c => {
      expect(c.__fromDefinition).toBeDefined();
      // Elements with contentReference don't have type, so only check if type exists
      if (c.type) {
        c.type.forEach(t => {
          expect(t.__kind).toBeDefined();
        });
      }
      // __name is only computed for elements with types, so only check if present
      if (c.__name) {
        expect(c.__name).toBeDefined();
      }
    });
  });

  it('gets children of a real slice referencing an extension profile (il-core-patient extension[hmo])', async () => {
    const children = await fetcher.getChildren('il-core-patient', 'extension[hmo]');
    expect(children.length).toBeGreaterThan(0);
    const fromDefs = new Set(children.map(c => c.__fromDefinition));
    expect(fromDefs.size).toBe(1);
    expect(fromDefs.has('http://fhir.health.gov.il/StructureDefinition/ext-il-hmo')).toBe(true);
    // ensure typical child elements exist
    expect(children.some(c => c.id === 'Extension.url')).toBe(true);
  });

  it('gets element of slice child with fixedUri (il-core-patient extension[hmo].url)', async () => {
    const el = await fetcher.getElement('il-core-patient', 'extension[hmo].url');
    expect(el.__fromDefinition).toBe('http://fhir.health.gov.il/StructureDefinition/ext-il-hmo');
    expect(el.fixedUri).toBe('http://fhir.health.gov.il/StructureDefinition/ext-il-hmo');
    expect(el.path).toBe('Extension.url');
  });
});
