import fs from 'fs-extra';
import path from 'path';

const targetDir = path.resolve('node_modules', '@outburn', 'structure-navigator');
const distSrc = path.resolve('dist');
const distDest = path.join(targetDir, 'dist');
const filesToCopy = ['README.md', 'LICENSE', 'package.json'];

console.log(`Creating ${targetDir}...`);
await fs.ensureDir(targetDir);

console.log(`Copying assets from ${distSrc} to ${distDest}...`);
await fs.copy(distSrc, distDest);

for (const file of filesToCopy) {
  const src = path.resolve(file);
  const dest = path.join(targetDir, path.basename(file));
  console.log(`Copying ${src} to ${dest}...`);
  await fs.copyFile(src, dest);
}

console.log('✅ Done.');
