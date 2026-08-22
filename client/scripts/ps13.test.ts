import assert from 'node:assert/strict';
import { spellPitchesPs13, type Ps13Note } from '../src/lib/midi/ps13.ts';

const NATURAL_PITCH_CLASSES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function spellingToMidi(spelling: string): number {
  const match = /^([A-G])(#{1,2}|b{1,2})?(-?\d+)$/.exec(spelling);
  assert(match, `invalid spelling: ${spelling}`);
  const accidental = match[2] ?? '';
  const alteration =
    accidental === '##'
      ? 2
      : accidental === '#'
        ? 1
        : accidental === 'bb'
          ? -2
          : accidental === 'b'
            ? -1
            : 0;
  return (
    12 * (Number(match[3]) + 1) + NATURAL_PITCH_CLASSES[match[1]] + alteration
  );
}

function melody(pitches: number[]): Ps13Note[] {
  return pitches.map((noteNumber, startTime) => ({ noteNumber, startTime }));
}

const aMajor = melody([69, 71, 73, 74, 76, 78, 80, 81]);
assert.deepEqual(spellPitchesPs13(aMajor), [
  'A4',
  'B4',
  'C#5',
  'D5',
  'E5',
  'F#5',
  'G#5',
  'A5',
]);

const fMinor = melody([65, 67, 68, 70, 72, 73, 75, 77]);
assert.deepEqual(spellPitchesPs13(fMinor), [
  'F4',
  'G4',
  'Ab4',
  'Bb4',
  'C5',
  'Db5',
  'Eb5',
  'F5',
]);

const contextualNotes = [
  ...aMajor,
  ...fMinor.map((note) => ({
    ...note,
    startTime: note.startTime + aMajor.length,
  })),
];
const contextualSpellings = spellPitchesPs13(contextualNotes);
contextualSpellings.forEach((spelling, index) => {
  assert(spelling, `unsupported accidental at note ${index}`);
  assert.equal(spellingToMidi(spelling), contextualNotes[index].noteNumber);
});

assert.deepEqual(spellPitchesPs13([]), []);
console.log('PS13 pitch-spelling tests passed');
