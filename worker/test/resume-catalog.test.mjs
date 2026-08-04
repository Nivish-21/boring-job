import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { parseResumeCatalog, loadResumeCatalog } from '../src/resume-catalog.mjs';

const SAMPLE_README = `# Tailored Resumes — Index

Some preamble text that is not part of the table.

| # | File | Target Role | Fit Score | Positioning Angle |
|---|---|---|---|---|
| 01 | Backend-SWE-NodePython | Backend Software Engineer (Node.js/Python) | 9.5 | Node + Python production build depth |
| 02 | Founding-Engineer | Founding Engineer | 9.5 | 0→1 ownership, solo build, ambiguity → shipped product |

Trailing notes after the table.
`;

test('parseResumeCatalog skips the header/separator and maps each row', () => {
  const catalog = parseResumeCatalog(SAMPLE_README, '/app/resumes');

  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0], {
    id: '01',
    pdf_path: join('/app/resumes', '01-Backend-SWE-NodePython.pdf'),
    docx_path: join('/app/resumes', '01-Backend-SWE-NodePython.docx'),
    reference_text_path: join('/app/resumes', 'reference', '01-Backend-SWE-NodePython.txt'),
    target_role: 'Backend Software Engineer (Node.js/Python)',
    fit_score: 9.5,
    positioning_angle: 'Node + Python production build depth'
  });
  assert.equal(catalog[1].id, '02');
  assert.equal(catalog[1].target_role, 'Founding Engineer');
});

test('loadResumeCatalog reads README.md from the resume directory', async () => {
  const catalog = await loadResumeCatalog('/app/resumes', {
    readFileImpl: async (path, encoding) => {
      assert.equal(encoding, 'utf8');
      if (path === join('/app/resumes', 'README.md')) return SAMPLE_README;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
  });
  assert.equal(catalog.length, 2);
});

test('loadResumeCatalog attaches reference_text when the extracted file exists, null otherwise', async () => {
  const catalog = await loadResumeCatalog('/app/resumes', {
    readFileImpl: async (path, encoding) => {
      assert.equal(encoding, 'utf8');
      if (path === join('/app/resumes', 'README.md')) return SAMPLE_README;
      if (path === join('/app/resumes', 'reference', '01-Backend-SWE-NodePython.txt')) return 'Real resume text for bucket 01.';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
  });
  assert.equal(catalog[0].reference_text, 'Real resume text for bucket 01.');
  assert.equal(catalog[1].reference_text, null);
});
