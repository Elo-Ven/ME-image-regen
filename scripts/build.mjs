import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import AdmZip from 'adm-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const packageRoot = path.join(dist, 'package');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

await rm(dist, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/client.js')],
  outfile: path.join(packageRoot, 'extension.js'),
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: false,
});
await copyFile(path.join(root, 'src/extension.css'), path.join(packageRoot, 'extension.css'));
await writeFile(path.join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const archive = path.join(dist, 'image-regen.zip');
const zip = new AdmZip();
zip.addLocalFolder(packageRoot);
zip.writeZip(archive);
console.log(`Built ${archive}`);
