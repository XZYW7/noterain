/**
 * Context-sensitive pitch spelling with the PS13s1 algorithm.
 *
 * This dependency-free TypeScript port follows the Apache-2.0-licensed
 * Partitura implementation by the CPJKU Music Informatics Group:
 * https://github.com/CPJKU/partitura/blob/main/partitura/musicanalysis/pitch_spelling.py
 *
 * Reference: David Meredith, "The ps13 Pitch Spelling Algorithm" (2006).
 */

export interface Ps13Note {
  noteNumber: number;
  startTime: number;
}

const STEPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
const UNDISPLACED_CHROMA = [0, 2, 3, 5, 7, 8, 10] as const;
const INITIAL_MORPH = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6] as const;
const MORPH_INTERVAL = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6] as const;

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function computeChromaVectors(
  chroma: number[],
  before: number,
  after: number,
): number[][] {
  const vector = new Array<number>(12).fill(0);
  for (let index = 0; index < Math.min(chroma.length, after); index++) {
    vector[chroma[index]]++;
  }

  const vectors = [vector.slice()];
  for (let index = 1; index < chroma.length; index++) {
    if (index + after <= chroma.length) {
      vector[chroma[index + after - 1]]++;
    }
    if (index - before > 0) {
      vector[chroma[index - before - 1]]--;
    }
    vectors.push(vector.slice());
  }
  return vectors;
}

function computeMorphs(chroma: number[], vectors: number[][]): number[] {
  const firstChroma = chroma[0];
  const firstMorph = INITIAL_MORPH[firstChroma];
  const tonicMorphs = Array.from({ length: 12 }, (_, tonicChroma) =>
    mod(
      firstMorph -
        MORPH_INTERVAL[mod(firstChroma - tonicChroma, MORPH_INTERVAL.length)],
      STEPS.length,
    ),
  );

  return chroma.map((noteChroma, noteIndex) => {
    const strengths = new Array<number>(STEPS.length).fill(0);
    for (let tonicChroma = 0; tonicChroma < 12; tonicChroma++) {
      const morph = mod(
        MORPH_INTERVAL[mod(noteChroma - tonicChroma, MORPH_INTERVAL.length)] +
          tonicMorphs[tonicChroma],
        STEPS.length,
      );
      strengths[morph] += vectors[noteIndex][tonicChroma];
    }

    let strongestMorph = 0;
    for (let morph = 1; morph < strengths.length; morph++) {
      if (strengths[morph] > strengths[strongestMorph]) {
        strongestMorph = morph;
      }
    }
    return strongestMorph;
  });
}

function computeMorpheticPitches(
  chromaticPitches: number[],
  morphs: number[],
): number[] {
  return chromaticPitches.map((chromaticPitch, index) => {
    const morphOctave = Math.floor(chromaticPitch / 12);
    const candidateOctaves = [morphOctave, morphOctave + 1, morphOctave - 1];
    const chromaticPosition = morphOctave + mod(chromaticPitch, 12) / 12;

    let bestOctave = candidateOctaves[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidateOctave of candidateOctaves) {
      const distance = Math.abs(
        chromaticPosition - (candidateOctave + morphs[index] / STEPS.length),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestOctave = candidateOctave;
      }
    }
    return morphs[index] + STEPS.length * bestOctave;
  });
}

/**
 * Spell every note in its local harmonic context.
 *
 * Results are aligned with the input array. A result is undefined only when
 * PS13 chooses an accidental beyond the double-sharp/double-flat range that
 * NoteRain and VexFlow currently support.
 */
export function spellPitchesPs13(
  notes: readonly Ps13Note[],
  before = 10,
  after = 40,
): (string | undefined)[] {
  if (notes.length === 0) return [];

  // PS13 processes equal-onset notes from low to high. Preserve input order
  // only as the final tie-breaker for exact pitch duplicates.
  const sortedIndexes = notes
    .map((_, index) => index)
    .sort(
      (left, right) =>
        notes[left].startTime - notes[right].startTime ||
        notes[left].noteNumber - notes[right].noteNumber ||
        left - right,
    );
  const chromaticPitches = sortedIndexes.map(
    (index) => notes[index].noteNumber - 21,
  );
  const chroma = chromaticPitches.map((pitch) => mod(pitch, 12));
  const vectors = computeChromaVectors(chroma, before, after);
  const morphs = computeMorphs(chroma, vectors);
  const morpheticPitches = computeMorpheticPitches(chromaticPitches, morphs);
  const results = new Array<string | undefined>(notes.length);

  sortedIndexes.forEach((originalIndex, sortedIndex) => {
    const morpheticPitch = morpheticPitches[sortedIndex];
    const morph = mod(morpheticPitch, STEPS.length);
    const alteration =
      chromaticPitches[sortedIndex] -
      12 * Math.floor(morpheticPitch / STEPS.length) -
      UNDISPLACED_CHROMA[morph];
    let octave = Math.floor(morpheticPitch / STEPS.length);
    if (morph > 1) octave++;

    const accidental =
      alteration === -2
        ? 'bb'
        : alteration === -1
          ? 'b'
          : alteration === 0
            ? ''
            : alteration === 1
              ? '#'
              : alteration === 2
                ? '##'
                : undefined;
    results[originalIndex] =
      accidental === undefined
        ? undefined
        : `${STEPS[morph]}${accidental}${octave}`;
  });

  return results;
}
