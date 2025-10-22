import templateAssembler from './lib/template-assembler.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const themePath = path.join(__dirname, '../cornerstone');
const templatesPath = path.join(themePath, 'templates');

// Test with a simple template
templateAssembler.assembleAndBundle(templatesPath, 'pages/home', (err, result) => {
    if (err) {
        console.error('Error:', err);
        return;
    }

    console.log('=== TEMPLATE STRUCTURE ===');
    console.log('Keys:', Object.keys(result));
    console.log('\n=== FIRST KEY DETAILS ===');
    const firstKey = Object.keys(result)[0];
    console.log('Key:', firstKey);
    console.log('Type:', typeof result[firstKey]);
    console.log('Length:', result[firstKey]?.length);
    console.log('\n=== FIRST 1000 CHARS ===');
    console.log(result[firstKey]?.substring(0, 1000));
});
