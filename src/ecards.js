'use strict';

// e-Reader cards for Pokémon Colosseum (Colosseum-e): a folder of the player's own card dumps, which the game reads
// behind Phenac Stadium's left door (the port's host/ecard.c, COLO_ECARD), shown on the Pokémon page with which of
// each card's levels the save has won, so the player can pick the card the next scan gives (COLO_ECARD_NEXT).
//
// A dump (.raw) is a long strip's 28 blocks, each 2 bytes of the strip's header and 102 of data. The data bytes are
// spread over 44 codewords of 64 bytes, 48 of data and 16 to correct errors: codeword k holds data bytes k, k + 44,
// k + 88, ... The codewords' data, in order, is the card's 2112 bytes, the game's card from byte 0x51: a bit stream,
// most significant bit first, the fields the game's decoder reads (cardedecode.c: its kind, 0 a trainer card and 1 a
// stadium card, then for a trainer card its series, title, place on the panel, level names, the panel's size, ...).
//
// The save keeps each series' panels (cardesavedata.c), from GRID in a save copy's body: a series' header (title, 0x1A
// its series, 0x1B levels, 0x1C rows, 0x1D columns), then each level's 0x76 bytes and 0x10 for each panel, a panel won
// when its byte 0xC is set. A card plays at its first level whose panel is empty.

const fs = require('node:fs');
const path = require('node:path');

const BLOCK = 104, BLOCK_DATA = 102, LONG_BLOCKS = 28, CODEWORDS = 44, CODEWORD_DATA = 48;
const CARD_STREAM = 0x51;
const GRID = 0x9A24, GRID_SIZE = 0x4000;
const TRAINER = 0, STADIUM = 1;

// The card's 2112 bytes from a long strip's dump, or null when it isn't one.
function cardBytes(raw) {
  if (raw.length !== LONG_BLOCKS * BLOCK) return null;
  const data = Buffer.concat(Array.from({ length: LONG_BLOCKS }, (_, b) => raw.subarray(b * BLOCK + 2, b * BLOCK + BLOCK)));
  const card = Buffer.alloc(CODEWORDS * CODEWORD_DATA);
  for (let k = 0; k < CODEWORDS; k++) for (let j = 0; j < CODEWORD_DATA; j++) card[k * CODEWORD_DATA + j] = data[k + CODEWORDS * j];
  return card.toString('latin1', 0x1A, 0x22) === 'NINTENDO' ? card : null;
}

function reader(bytes) {
  let at = 0;
  const bits = n => {
    let value = 0;
    for (let i = 0; i < n; i++, at++) value = value * 2 + ((bytes[at >> 3] >> (7 - (at & 7))) & 1);
    return value;
  };
  // The game's characters, 16 bits each, to the first 0; its e-Reader mark (0x337C) as e+.
  const text = width => {
    let out = '', ended = false;
    for (let used = 0; used < width; used += 16) {
      const c = bits(Math.min(16, width - used));
      if (!c) ended = true;
      if (ended) continue;
      out += c === 0x337C ? 'e+' : c >= 0x20 && c < 0xFFFF ? String.fromCharCode(c) : '';
    }
    return out.trim();
  };
  return { bits, text, skip: n => { at += n; } };
}

// What the launcher shows of a card: its kind, and for a trainer card its series, place, levels and first trainer.
function readCard(raw) {
  const card = cardBytes(raw);
  if (!card) return null;
  const r = reader(card.subarray(CARD_STREAM));
  const kind = r.bits(4);
  if (kind === STADIUM) { r.skip(6); return { kind, name: r.text(240) }; }
  if (kind !== TRAINER) return null;
  r.skip(3 + 2 + 4 + 4);
  const series = r.bits(8), title = r.text(192);
  const row = r.bits(3) - 1, rowType = r.bits(3), column = r.bits(3) - 1;
  const levelNames = [r.text(112), r.text(112), r.text(112)];
  const levels = r.bits(2), rows = r.bits(3), columns = r.bits(3);
  r.skip(9 * 4 + 3 * 10 + 3 * 7 + 9 * 720);
  const trainer = r.text(80);
  return { kind, series, title, row, rowType, column, levels, rows, columns, levelNames: levelNames.slice(0, levels), trainer,
    number: row * columns + column + 1 };
}

// Each series' panels in a save copy's body: series -> { levels, rows, columns, won(level, row, column) }.
function panels(plain) {
  const out = new Map();
  if (!plain || plain.length < GRID + GRID_SIZE) return out;
  for (let at = GRID; at + 0x24 <= GRID + GRID_SIZE && plain.readUInt16BE(at);) {
    const levels = plain[at + 0x1B], rows = plain[at + 0x1C], columns = plain[at + 0x1D];
    if (levels > 3 || rows > 6 || columns > 5) break;
    const stride = 0x76 + rows * columns * 0x10, base = at;
    out.set(plain[at + 0x1A], { levels, rows, columns,
      won: (level, row, column) => row >= 0 && row < rows && column >= 0 && column < columns &&
        plain[base + 0x24 + level * stride + 0x76 + (row * columns + column) * 0x10 + 0xC] !== 0 });
    at += 0x24 + levels * stride;
  }
  return out;
}

// A folder's cards, in name order, each with which of its levels the save has won and the level it plays at next.
function list(folder, plain) {
  let names = [];
  try { names = fs.readdirSync(folder).filter(name => /\.raw$/i.test(name) && !name.startsWith('.')).sort(); } catch (_) { return []; }
  const saved = panels(plain), cards = [];
  for (const file of names) {
    let card = null;
    try { card = readCard(fs.readFileSync(path.join(folder, file))); } catch (_) { /* unreadable: left out */ }
    if (!card) continue;
    if (card.kind === STADIUM) { cards.push({ file, kind: 'stadium', name: card.name }); continue; }
    const grid = saved.get(card.series);
    const won = Array.from({ length: card.levels }, (_, level) => Boolean(grid?.won(level, card.row, card.column)));
    const next = won.indexOf(false);
    cards.push({ file, kind: 'trainer', series: card.series, title: card.title, number: card.number, trainer: card.trainer,
      levelNames: card.levelNames, won, next: next < 0 ? null : next });
  }
  return cards;
}

// Card dumps copied into `folder` (the launcher's own e-Reader folder), each checked first: { imported, skipped }, the
// skipped ones not a Pokémon Colosseum-e card dump. A card already there by that name is replaced.
function importCards(files, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const imported = [], skipped = [];
  for (const file of files) {
    let raw = null;
    try { raw = fs.readFileSync(file); } catch (_) { /* unreadable */ }
    if (!raw || !readCard(raw)) { skipped.push(path.basename(file)); continue; }
    fs.writeFileSync(path.join(folder, path.basename(file)), raw);
    imported.push(path.basename(file));
  }
  return { imported, skipped };
}

module.exports = { cardBytes, readCard, panels, list, importCards, GRID };
