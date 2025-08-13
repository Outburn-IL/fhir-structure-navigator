import { FhirSnapshotGenerator } from 'fhir-snapshot-generator';
import { FhirStructureNavigator } from '@outburn/structure-navigator';

const context = ['il.core.fhir.r4#0.17.0', 'fsg.test.pkg#0.1.0'];

void async function () {
  let fetcher: FhirStructureNavigator;
  const fsg = await FhirSnapshotGenerator.create({
    context,
    cachePath: './test/.test-cache',
    fhirVersion: '4.0.1',
    cacheMode: 'lazy'
  });
  fetcher = new FhirStructureNavigator(fsg);

  const root = 'il-core-patient';
  const path = 'extension[hmo].url';
  const element = await fetcher.getElement(root, path);
  // console.log(`Children of ${root}.${path}:`, children.map(c => ({ id: c.id, from: c.__fromDefinition, min: c.min })));
  console.log(`Element of ${root}.${path}:`, element);

}();
