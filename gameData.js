'use strict';
const fs = require('node:fs');
const path = require('node:path');

function normalizePlayer(p) {
  const pos = (p.position || '').toUpperCase();
  const pri = (p.primary || '').toUpperCase();
  const primaryRole = p.category === 'manager' ? 'manager'
    : pos === 'GK' || pri === 'GK' ? 'goalkeeper'
    : ['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(pos) || pri === 'DEF' ? 'defender'
    : ['CM', 'CDM', 'CAM', 'LM', 'RM'].includes(pos) || pri === 'MID' ? 'midfielder' : 'forward';
  return { ...p, primaryRole };
}

function validateData(rows, kind) {
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${kind}.json must be a non-empty array.`);
  return rows.map((row, index) => {
    const fail = message => { throw new Error(`${kind}.json entry ${index + 1}: ${message}`); };
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('expected an object.');
    for (const field of ['name', 'category', 'nationality']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) fail(`${field} must be a non-empty string.`);
    }
    if (kind === 'managers' && row.category !== 'manager') fail('category must be manager.');
    if (kind === 'players' && !['icons', 'hearts', 'young gen', 'normal'].includes(row.category.toLowerCase().trim())) fail('unknown player category.');
    if (!Number.isSafeInteger(row.baseprice) || row.baseprice < 0) fail('baseprice must be a non-negative integer.');
    if (!Number.isFinite(row.overall) || row.overall < 0 || row.overall > 100) fail('overall must be a number from 0 to 100.');
    if (kind === 'players' && (typeof row.position !== 'string' || typeof row.primary !== 'string')) fail('position and primary are required.');
    const item = normalizePlayer(row);
    const stats = kind === 'managers' ? ['attacking', 'tactics', 'discipline', 'adaptability', 'motivation', 'defense']
      : item.primaryRole === 'goalkeeper' ? ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning']
      : ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical'];
    if (!row.attributes || stats.some(key => !Number.isFinite(row.attributes[key]))) fail(`attributes must include numeric ${stats.join(', ')}.`);
    // Only validated game fields enter persisted rooms or public snapshots.
    return { name: row.name, category: row.category, nationality: row.nationality, overall: row.overall,
      baseprice: row.baseprice, position: row.position || 'MGR', primary: row.primary || 'MGR',
      preferredFormation: typeof row.preferredFormation === 'string' ? row.preferredFormation : '',
      primaryRole: item.primaryRole, attributes: Object.fromEntries(stats.map(key => [key, row.attributes[key]])) };
  });
}

function loadGameData(directory = path.resolve(__dirname, 'data'), { allowMissing = false } = {}) {
  const data = {};
  for (const kind of ['players', 'managers']) {
    const file = path.resolve(directory, `${kind}.json`);
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') {
        console.warn(`UFA game data missing: ${file}. Lobby Create/Join remains available; Start Auction is disabled.`);
        data[kind] = [];
        continue;
      }
      throw new Error(`Cannot load required ${file}: ${error.code || 'invalid JSON'}. Supply the real game dataset before starting an auction.`);
    }
    data[kind] = validateData(rows, kind);
    console.log(`Loaded ${data[kind].length} ${kind}`);
  }
  return data;
}

module.exports = { loadGameData, validateData, normalizePlayer };
