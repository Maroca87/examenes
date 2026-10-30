import fs from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('dist');
await fs.mkdir(output, { recursive:true });
for (const file of ['index.html','app.js','styles.css','_headers']) {
  await fs.copyFile(path.resolve(file), path.join(output,file));
}
console.log('Archivos públicos listos en dist/.');
