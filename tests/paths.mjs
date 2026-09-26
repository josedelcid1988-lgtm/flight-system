import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TEST_DIR, '..');
export const testPath = relative => path.join(TEST_DIR, relative);
export const testUrl = relative => pathToFileURL(testPath(relative)).href;
