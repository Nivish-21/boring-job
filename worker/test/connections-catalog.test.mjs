import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConnectionsCsv, isFounderTitle, filterFounders } from '../src/connections-catalog.mjs';

const sampleCsv = [
  'Notes:',
  '"When exporting your connection data, you will see the header row below."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Jane,Doe,https://www.linkedin.com/in/janedoe,jane@example.com,"Nimbus, Inc.",Co-Founder,01 Jan 2026',
  'John,Smith,https://www.linkedin.com/in/johnsmith,,Acme Corp,Software Engineer,02 Jan 2026',
  'Priya,Rao,https://www.linkedin.com/in/priyarao,priya@example.com,Zenith Labs,Founding Engineer,03 Jan 2026',
  'Alex,Kim,https://www.linkedin.com/in/alexkim,,Globex,CEO,04 Jan 2026'
].join('\n');

test('parseConnectionsCsv scans past the Notes: preamble to the real header row', () => {
  const rows = parseConnectionsCsv(sampleCsv);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    first_name: 'Jane',
    last_name: 'Doe',
    profile_url: 'https://www.linkedin.com/in/janedoe',
    email: 'jane@example.com',
    company: 'Nimbus, Inc.',
    position: 'Co-Founder',
    connected_on: '01 Jan 2026'
  });
});

test('parseConnectionsCsv keeps a comma inside a quoted cell intact', () => {
  const rows = parseConnectionsCsv(sampleCsv);
  assert.equal(rows[0].company, 'Nimbus, Inc.');
});

test('parseConnectionsCsv throws when the expected header row is missing', () => {
  assert.throws(() => parseConnectionsCsv('just,some,random,csv\n1,2,3,4'), /missing the expected/);
});

test('isFounderTitle matches founder-shaped titles and rejects plain ones', () => {
  assert.equal(isFounderTitle('Co-Founder'), true);
  assert.equal(isFounderTitle('Founding Engineer'), true);
  assert.equal(isFounderTitle('CEO'), true);
  assert.equal(isFounderTitle('Founder & CEO'), true);
  assert.equal(isFounderTitle('Software Engineer'), false);
  assert.equal(isFounderTitle('Product Manager'), false);
  assert.equal(isFounderTitle(''), false);
  assert.equal(isFounderTitle(undefined), false);
});

test('filterFounders keeps only connections with a founder-shaped position', () => {
  const founders = filterFounders(parseConnectionsCsv(sampleCsv));
  assert.deepEqual(founders.map((founder) => founder.first_name), ['Jane', 'Priya', 'Alex']);
});
