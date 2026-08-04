import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const parseTableRow = (line) => {
  const cells = line.split('|').map((cell) => cell.trim());
  return cells.slice(1, -1);
};

export const parseResumeCatalog = (markdown, resumeDir) => {
  const rows = markdown.split('\n').filter((line) => line.trim().startsWith('|')).slice(2);
  return rows.map((line) => {
    const [num, file, targetRole, fitScore, positioningAngle] = parseTableRow(line);
    return {
      id: num,
      pdf_path: join(resumeDir, `${num}-${file}.pdf`),
      docx_path: join(resumeDir, `${num}-${file}.docx`),
      reference_text_path: join(resumeDir, 'reference', `${num}-${file}.txt`),
      target_role: targetRole,
      fit_score: Number(fitScore),
      positioning_angle: positioningAngle
    };
  });
};

// reference_text is a one-time text extraction of the resume's own PDF (see docs/decisions.md
// for why it lives outside the git repo), used to give the LLM real structure/tone/experience
// instead of just the README's target_role/positioning_angle line. Missing extraction (not yet
// generated, or a bucket added without one) degrades to null rather than failing catalog load.
export const loadResumeCatalog = async (resumeDir, { readFileImpl = readFile } = {}) => {
  const markdown = await readFileImpl(join(resumeDir, 'README.md'), 'utf8');
  const catalog = parseResumeCatalog(markdown, resumeDir);
  return Promise.all(catalog.map(async (bucket) => {
    try {
      const reference_text = await readFileImpl(bucket.reference_text_path, 'utf8');
      return { ...bucket, reference_text };
    } catch {
      return { ...bucket, reference_text: null };
    }
  }));
};
