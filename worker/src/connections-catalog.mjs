// LinkedIn's official data-export CSV has a "Notes:" preamble before the real header row, so the
// header can't be assumed to be line 0. Company/position names can contain commas inside quoted
// cells, so a plain split(',') would corrupt them -- hand-rolled quoted-cell splitter instead
// (matches this project's zero-runtime-dependency pattern).
const splitCsvLine = (line) => {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
      else if (char === '"') { inQuotes = false; }
      else { current += char; }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
};

export const parseConnectionsCsv = (csvText) => {
  const lines = String(csvText).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith('First Name,Last Name'));
  if (headerIndex === -1) throw new Error('connections CSV is missing the expected "First Name,Last Name..." header row');

  const header = splitCsvLine(lines[headerIndex]);
  return lines
    .slice(headerIndex + 1)
    .filter((line) => line.trim())
    .map((line) => {
      const cells = splitCsvLine(line);
      const row = Object.fromEntries(header.map((name, index) => [name, cells[index] || '']));
      return {
        first_name: row['First Name'] || '',
        last_name: row['Last Name'] || '',
        profile_url: row['URL'] || '',
        email: row['Email Address'] || '',
        company: row['Company'] || '',
        position: row['Position'] || '',
        connected_on: row['Connected On'] || ''
      };
    });
};

const FOUNDER_TITLE_PATTERN = /\b(?:co-?founder|founding|founder|ceo|chief executive)\b/i;

export const isFounderTitle = (position) => typeof position === 'string' && FOUNDER_TITLE_PATTERN.test(position);

export const filterFounders = (connections) => connections.filter((connection) => isFounderTitle(connection.position));
