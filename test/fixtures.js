'use strict';
// Protocol test doubles only. These are never loaded by npm start or written to data/.
const { validateData } = require('../gameData');
const attributes = Object.fromEntries(['attacking', 'tactics', 'discipline', 'adaptability', 'motivation', 'defense',
  'diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning', 'pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical'].map(key => [key, 50]));
function lot(name, position, category = 'normal') {
  return { name, position, primary: position, category, nationality: 'Test', overall: 50, baseprice: 10, attributes };
}
function testData() {
  return {
    managers: validateData([lot('Test manager A', 'MGR', 'manager'), lot('Test manager B', 'MGR', 'manager')], 'managers'),
    players: validateData(['CM', 'ST', 'GK', 'CB'].map(position => lot('Test lot ' + position, position)), 'players')
  };
}
module.exports = { testData, lot };
