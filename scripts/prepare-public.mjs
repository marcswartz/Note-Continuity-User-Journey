import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'Apple Notes feature launch');
const publicDir = join(root, 'public');

mkdirSync(publicDir, { recursive: true });
cpSync(join(sourceDir, 'Apple Notes.dc.html'), join(publicDir, 'index.html'));
cpSync(join(sourceDir, 'support.js'), join(publicDir, 'support.js'));
