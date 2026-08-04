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
      target_role: targetRole,
      fit_score: Number(fitScore),
      positioning_angle: positioningAngle
    };
  });
};

export const loadResumeCatalog = async (resumeDir, { readFileImpl = readFile } = {}) => {
  const markdown = await readFileImpl(join(resumeDir, 'README.md'), 'utf8');
  return parseResumeCatalog(markdown, resumeDir);
};
