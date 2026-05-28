import { copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

mkdirSync('dist/src/background', { recursive: true });
mkdirSync('dist/src/content', { recursive: true });

copyFileSync('manifest.json', join('dist', 'manifest.json'));
copyFileSync('src/background/index.js', join('dist', 'src/background/index.js'));
copyFileSync('src/content/index.js', join('dist', 'src/content/index.js'));
copyFileSync('src/content/styles.css', join('dist', 'src/content/styles.css'));

console.log('Files copied to dist/');
