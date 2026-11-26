'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ecards = require('../src/ecards');

// A card's bit stream as the game's decoder reads it (cardedecode.c), most significant bit first.
function writer() {
  const bits = [];
  const put = (value, width) => { for (let i = width - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) % 2); };
  const text = (string, width) => {
    const units = [...string].map(c => c.charCodeAt(0));
    for (let used = 0, i = 0; used < width; used += 16, i++) put(units[i] || 0, Math.min(16, width - used));
  };
  const bytes = () => {
    const out = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((bit, i) => { if (bit) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  };
  return { put, text, bytes };
}

// A trainer card at panel (row, column), counted from 1 as the card has them; its first trainer `trainer`.
function trainerStream({ series = 1, row = 1, column = 1, trainer = 'DRAW', levels = ['Easy', 'Normal', 'Hard'] } = {}) {
  const w = writer();
  w.put(0, 4); w.put(1, 3); w.put(3, 2); w.put(1, 4); w.put(11, 4);
  w.put(series, 8);
  w.text('Colosseum ㍼', 192);
  w.put(row, 3); w.put(4, 3); w.put(column, 3);
  for (const name of levels) w.text(name, 112);
  w.put(levels.length, 2); w.put(4, 3); w.put(5, 3);
  for (let i = 0; i < 9; i++) w.put(i + 1, 4);
  for (let i = 0; i < 3; i++) w.put(0, 10);
  for (let i = 0; i < 3; i++) w.put(0, 7);
  for (let i = 0; i < 9; i++) w.text('', 720);
  w.text(trainer, 80);
  return w.bytes();
}
function stadiumStream(name) {
  const w = writer();
  w.put(1, 4); w.put(5, 6); w.text(name, 240);
  return w.bytes();
}

// The card's 2112 bytes (a header with NINTENDO, the stream from 0x51), spread over a long strip's blocks as a dump.
function rawDump(stream) {
  const card = Buffer.alloc(44 * 48);
  card.write('NINTENDO', 0x1A, 'latin1');
  stream.copy(card, 0x51);
  const data = Buffer.alloc(28 * 102);
  for (let k = 0; k < 44; k++) for (let j = 0; j < 48; j++) data[k + 44 * j] = card[k * 48 + j];
  const raw = Buffer.alloc(28 * 104);
  for (let b = 0; b < 28; b++) data.copy(raw, b * 104 + 2, b * 102, b * 102 + 102);
  return raw;
}

// A save copy's body with series 1's panels (3 levels, 4 x 5), `won` its won panels as [level, row, column].
function plainWith(won) {
  const plain = Buffer.alloc(ecards.GRID + 0x4000 + 0x100);
  const at = ecards.GRID, stride = 0x76 + 4 * 5 * 0x10;
  plain.writeUInt16BE(0x43, at);   // the series' title ("C...") makes the record there
  plain[at + 0x1A] = 1; plain[at + 0x1B] = 3; plain[at + 0x1C] = 4; plain[at + 0x1D] = 5;
  for (const [level, row, column] of won) plain[at + 0x24 + level * stride + 0x76 + (row * 5 + column) * 0x10 + 0xC] = 1;
  return plain;
}

test('a card dump is read as the game reads it: series, panel, levels and first trainer', () => {
  const card = ecards.readCard(rawDump(trainerStream({ row: 2, column: 5, trainer: 'SILDY' })));
  assert.equal(card.kind, 0);
  assert.equal(card.series, 1);
  assert.equal(card.title, 'Colosseum e+');
  assert.deepEqual([card.row, card.column, card.number], [1, 4, 10]);
  assert.deepEqual(card.levelNames, ['Easy', 'Normal', 'Hard']);
  assert.equal(card.trainer, 'SILDY');
  assert.equal(ecards.readCard(Buffer.alloc(100)), null, 'not a long strip');
  const notCard = rawDump(trainerStream());
  // card byte 0x1A (NINTENDO's N): codeword 0, byte 26, so data byte 44 * 26, in block 11
  const data = 44 * 26;
  notCard[Math.floor(data / 102) * 104 + 2 + (data % 102)] ^= 0xFF;
  assert.equal(ecards.readCard(notCard), null);
});

test("a folder's cards show which levels the save has won and the level each plays at next", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ecards-'));
  try {
    fs.writeFileSync(path.join(folder, 'A001.raw'), rawDump(trainerStream({ row: 1, column: 1, trainer: 'DRAW' })));
    fs.writeFileSync(path.join(folder, 'A010.raw'), rawDump(trainerStream({ row: 2, column: 5, trainer: 'SILDY' })));
    fs.writeFileSync(path.join(folder, 'M001.raw'), rawDump(stadiumStream('PYRITE CLSM')));
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a card');
    const cards = ecards.list(folder, plainWith([[0, 0, 0], [1, 0, 0], [0, 1, 4]]));
    assert.deepEqual(cards.map(card => card.file), ['A001.raw', 'A010.raw', 'M001.raw']);
    assert.deepEqual([cards[0].won, cards[0].next], [[true, true, false], 2]);
    assert.deepEqual([cards[1].won, cards[1].next], [[true, false, false], 1]);
    assert.deepEqual([cards[2].kind, cards[2].name], ['stadium', 'PYRITE CLSM']);
    // no save yet: every card plays at its first level
    assert.deepEqual(ecards.list(folder, null).filter(card => card.kind === 'trainer').map(card => card.next), [0, 0]);
    assert.deepEqual(ecards.list(path.join(folder, 'missing'), null), []);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('card dumps are imported into a folder of their own, what isn\'t a card left out', () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'ecards-from-')), to = path.join(os.tmpdir(), `ecards-to-${process.pid}`);
  try {
    fs.writeFileSync(path.join(from, 'A001.raw'), rawDump(trainerStream()));
    fs.writeFileSync(path.join(from, 'broken.raw'), Buffer.alloc(28 * 104));
    const result = ecards.importCards([path.join(from, 'A001.raw'), path.join(from, 'broken.raw'), path.join(from, 'missing.raw')], to);
    assert.deepEqual(result, { imported: ['A001.raw'], skipped: ['broken.raw', 'missing.raw'] });
    assert.deepEqual(fs.readdirSync(to), ['A001.raw']);
    assert.equal(ecards.list(to, null)[0].trainer, 'DRAW');
  } finally { for (const dir of [from, to]) fs.rmSync(dir, { recursive: true, force: true }); }
});
