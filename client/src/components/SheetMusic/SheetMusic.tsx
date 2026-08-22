import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Renderer,
  Stave,
  StaveNote,
  GhostNote,
  Voice,
  Formatter,
  Accidental,
  StaveConnector,
  Beam,
  Fraction,
  Dot,
  StaveTie,
  Tuplet,
  Stem,
} from 'vexflow';
import { useMidiStore } from '../../stores/midiStore';
import type {
  KeySignature,
  KeySignatureChange,
  MidiNote,
  MidiTrack,
} from '../../types/midi';
import styles from './SheetMusic.module.css';

interface SheetMusicProps {
  /** Override beats per measure (defaults to file's time signature) */
  beatsPerMeasure?: number;
}

/**
 * Convert MIDI key signature (-7 to 7) to VexFlow key name
 * Negative = flats, positive = sharps
 */
function midiKeyToVexFlow(key: number): string {
  // A MIDI key-signature event already stores the signed number of accidentals.
  // Major and minor modes with the same `key` value therefore use the same
  // engraved signature; `scale` only identifies the mode. VexFlow interprets
  // names such as "D" as D major, so mapping D minor to "D" would incorrectly
  // draw two sharps instead of the one flat encoded by MIDI key = -1.
  const signaturesByFifths: Record<string, string> = {
    '-7': 'Cb',
    '-6': 'Gb',
    '-5': 'Db',
    '-4': 'Ab',
    '-3': 'Eb',
    '-2': 'Bb',
    '-1': 'F',
    '0': 'C',
    '1': 'G',
    '2': 'D',
    '3': 'A',
    '4': 'E',
    '5': 'B',
    '6': 'F#',
    '7': 'C#',
  };
  return signaturesByFifths[String(key)] || 'C';
}

/** Get which pitch classes have sharps/flats for a given MIDI key signature */
function getKeySignatureAlterations(key: number): {
  sharps: Set<number>;
  flats: Set<number>;
} {
  // Order of sharps: F C G D A E B (pitch classes: 5, 0, 7, 2, 9, 4, 11 -> mod 12 for black keys: 6, 1, 8, 3, 10)
  // Order of flats: B E A D G C F (pitch classes: 11, 4, 9, 2, 7, 0, 5 -> mod 12 for black keys: 10, 3, 8, 1, 6)
  const sharpOrder = [6, 1, 8, 3, 10, 5, 0]; // F#, C#, G#, D#, A#, E#, B#
  const flatOrder = [10, 3, 8, 1, 6, 11, 4]; // Bb, Eb, Ab, Db, Gb, Cb, Fb

  const sharps = new Set<number>();
  const flats = new Set<number>();

  if (key > 0) {
    for (let i = 0; i < key; i++) {
      sharps.add(sharpOrder[i]);
    }
  } else if (key < 0) {
    for (let i = 0; i < -key; i++) {
      flats.add(flatOrder[i]);
    }
  }

  return { sharps, flats };
}

/** Detect key signature from notes when MIDI file doesn't have one */
function detectKeySignature(notes: MidiNote[]): number {
  if (notes.length === 0) return 0;

  // Count pitch classes (0-11)
  const pitchCounts = new Array(12).fill(0);
  for (const note of notes) {
    pitchCounts[note.noteNumber % 12]++;
  }

  // Test each key signature and count how many accidentals would be needed
  // Prefer keys with fewer accidentals in signature (closer to C major)
  let bestKey = 0;
  let fewestAccidentals = Infinity;

  // Only test common keys (-4 to 4, i.e., Ab major to E major)
  for (let key = -4; key <= 4; key++) {
    const { sharps, flats } = getKeySignatureAlterations(key);
    let accidentalsNeeded = 0;

    for (let pc = 0; pc < 12; pc++) {
      const count = pitchCounts[pc];
      if (count === 0) continue;

      const isBlackKey = [1, 3, 6, 8, 10].includes(pc);

      if (isBlackKey) {
        // Black key needs accidental if not in key signature
        if (!sharps.has(pc) && !flats.has(pc)) {
          accidentalsNeeded += count;
        }
      }
      // White keys don't need accidentals in these common keys
    }

    // Prefer fewer accidentals, with tiebreaker favoring fewer sharps/flats in signature
    const tiebreaker = Math.abs(key) * 0.001;
    const score = accidentalsNeeded + tiebreaker;

    if (score < fewestAccidentals) {
      fewestAccidentals = score;
      bestKey = key;
    }
  }

  return bestKey;
}

/** Return the latest key signature active at a playback time. */
function keySignatureAtTime(
  changes: KeySignatureChange[],
  time: number,
  fallback: KeySignature,
): KeySignature {
  let active = fallback;
  for (const change of changes) {
    if (change.time <= time + 0.001) {
      active = change;
    } else {
      break;
    }
  }
  return active;
}

type EffectiveAccidental = '#' | '##' | 'b' | 'bb' | 'n';

interface SpelledMidiNote {
  key: string;
  effectiveAccidental: EffectiveAccidental;
}

/**
 * Spell a MIDI pitch for the current key. MIDI has no written spelling, so
 * ordinary files use the reader-friendly natural/one-accidental spelling.
 * A source may attach an explicit spelling hint for the rare notes that are
 * genuinely written as B#, F##, or a double-flat.
 */
function midiToVexFlow(
  noteNumber: number,
  keyNum: number,
  spelling?: string,
  preferredSpelling?: 'bSharp',
): SpelledMidiNote {
  const octave = Math.floor(noteNumber / 12) - 1;
  const pc = noteNumber % 12;

  if (spelling) {
    const match = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d+)$/.exec(spelling);
    if (match) {
      const naturalPitchClasses: Record<string, number> = {
        c: 0,
        d: 2,
        e: 4,
        f: 5,
        g: 7,
        a: 9,
        b: 11,
      };
      const letter = match[1].toLowerCase();
      const accidentalText = match[2] ?? '';
      const alteration =
        accidentalText === '##'
          ? 2
          : accidentalText === '#'
            ? 1
            : accidentalText === 'bb'
              ? -2
              : accidentalText === 'b'
                ? -1
                : 0;
      const writtenOctave = Number(match[3]);
      const writtenMidi =
        12 * (writtenOctave + 1) + naturalPitchClasses[letter] + alteration;
      if (writtenMidi === noteNumber) {
        const effectiveAccidental: EffectiveAccidental =
          alteration === 2
            ? '##'
            : alteration === 1
              ? '#'
              : alteration === -2
                ? 'bb'
                : alteration === -1
                  ? 'b'
                  : 'n';
        return {
          key: `${letter}/${writtenOctave}`,
          effectiveAccidental,
        };
      }
    }
  }

  if (preferredSpelling === 'bSharp' && pc === 0) {
    return { key: `b/${octave - 1}`, effectiveAccidental: '#' };
  }

  // Pitch classes: C=0, C#=1, D=2, D#=3, E=4, F=5, F#=6, G=7, G#=8, A=9, A#=10, B=11
  const naturalNames = [
    'c',
    'c',
    'd',
    'd',
    'e',
    'f',
    'f',
    'g',
    'g',
    'a',
    'a',
    'b',
  ];
  const isBlackKey = [1, 3, 6, 8, 10].includes(pc);

  let noteName = naturalNames[pc];
  let effectiveAccidental: EffectiveAccidental = 'n';

  if (isBlackKey) {
    if (keyNum < 0) {
      const flatNames = [
        'c',
        'd',
        'd',
        'e',
        'e',
        'f',
        'g',
        'g',
        'a',
        'a',
        'b',
        'b',
      ];
      noteName = flatNames[pc];
      effectiveAccidental = 'b';
    } else {
      // Sharp keys and a key-neutral MIDI file keep the conventional sharp
      // spelling for black-key pitch classes.
      effectiveAccidental = '#';
    }
  }

  return {
    key: `${noteName}/${octave}`,
    effectiveAccidental,
  };
}

/** The accidental supplied by the key signature for a staff letter. */
function getKeySignatureAccidental(
  key: string,
  keyNum: number,
): EffectiveAccidental {
  const noteName = key[0];
  const sharpLetters = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
  const flatLetters = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
  if (keyNum > 0 && sharpLetters.slice(0, keyNum).includes(noteName)) {
    return '#';
  }
  if (keyNum < 0 && flatLetters.slice(0, -keyNum).includes(noteName)) {
    return 'b';
  }
  return 'n';
}

/**
 * Get VexFlow beam groupings based on time signature.
 *
 * Music notation rules:
 * - Only 8th notes or shorter can be beamed
 * - "A new beam = a new beat" - beam notes within the same beat
 * - Never beam across bar lines
 * - Never beam across the center of a measure (critical in 4/4)
 */
function getBeamGroupsForTimeSignature(
  beatsPerMeasure: number,
  beatValue: number,
): Fraction[] {
  // Compound meters (6/8, 9/8, 12/8) - beam in groups of 3 eighth notes
  if (beatValue === 8 && beatsPerMeasure % 3 === 0) {
    const numGroups = beatsPerMeasure / 3;
    return Array(numGroups)
      .fill(null)
      .map(() => new Fraction(3, 8));
  }

  // Simple meters - beam based on beat structure
  switch (beatValue) {
    case 4: // Quarter note beats
      switch (beatsPerMeasure) {
        case 4: // 4/4 - Two groups of 4 eighths (beats 1-2 and 3-4, NEVER across center)
          return [new Fraction(4, 8), new Fraction(4, 8)];
        case 3: // 3/4 - Three groups of 2 eighths
          return [new Fraction(2, 8), new Fraction(2, 8), new Fraction(2, 8)];
        case 2: // 2/4 - One group of 4 eighths
          return [new Fraction(4, 8)];
        case 6: // 6/4 - Two groups of 6 eighths
          return [new Fraction(6, 8), new Fraction(6, 8)];
        default:
          // Default to 2 eighths per beat
          return Array(beatsPerMeasure)
            .fill(null)
            .map(() => new Fraction(2, 8));
      }
    case 8: // Eighth note beats (simple, not compound - e.g., 5/8, 7/8)
      if (beatsPerMeasure === 5) {
        return [new Fraction(3, 8), new Fraction(2, 8)];
      }
      if (beatsPerMeasure === 7) {
        return [new Fraction(2, 8), new Fraction(2, 8), new Fraction(3, 8)];
      }
      // Default grouping for other 8th note meters
      return [new Fraction(beatsPerMeasure, 8)];
    case 2: // Half note beats (2/2, 3/2, etc.)
      // Beam in groups of 4 eighths per half-note beat
      return Array(beatsPerMeasure)
        .fill(null)
        .map(() => new Fraction(4, 8));
    case 16: // Sixteenth note beats
      return [new Fraction(beatsPerMeasure, 16)];
    default:
      // Fallback: 2 eighths per beat
      return [new Fraction(2, 8)];
  }
}

/** Determine clef based on average note pitch */
function getClefForTrack(notes: MidiNote[]): 'treble' | 'bass' {
  if (notes.length === 0) return 'treble';
  const avgNote =
    notes.reduce((sum, n) => sum + n.noteNumber, 0) / notes.length;
  return avgNote >= 60 ? 'treble' : 'bass'; // Middle C = 60
}

/** A note segment clipped to one measure, while retaining its source identity. */
interface NotationNote {
  sourceId: string;
  noteNumber: number;
  spelling?: string;
  startTime: number;
  endTime: number;
  originalStartTime: number;
  originalEndTime: number;
  midiStartTime: number;
  midiEndTime: number;
}

/** Group notes into measures */
interface Measure {
  startTime: number;
  endTime: number;
  notes: NotationNote[];
}

function groupNotesIntoMeasures(
  notes: MidiNote[],
  duration: number,
  bpm: number,
  beatsPerMeasure: number,
  beatValue: number = 4,
): Measure[] {
  const secondsPerQuarterNote = 60 / bpm;
  const quarterNotesPerMeasure = beatsPerMeasure * (4 / beatValue);
  const secondsPerMeasure = secondsPerQuarterNote * quarterNotesPerMeasure;
  const lastNoteEnd = notes.reduce(
    (latest, note) => Math.max(latest, note.startTime + note.duration),
    duration,
  );
  const measureCount = Math.max(1, Math.ceil(lastNoteEnd / secondsPerMeasure));
  const measures: Measure[] = [];

  for (let i = 0; i < measureCount; i++) {
    const startTime = i * secondsPerMeasure;
    const endTime = (i + 1) * secondsPerMeasure;
    measures.push({ startTime, endTime, notes: [] });
  }

  // Work on an integer 32nd-note grid. Each source note is clipped into every
  // measure it overlaps so that sustained notes can be notated and tied across
  // barlines instead of occupying only their onset measure.
  const quantizeGrid = secondsPerQuarterNote / 8;
  const gridStepsPerMeasure = Math.round(quarterNotesPerMeasure * 8);
  notes.forEach((note, sourceIndex) => {
    const startStep = Math.max(0, Math.round(note.startTime / quantizeGrid));
    const endStep = Math.max(
      startStep + 1,
      Math.round((note.startTime + note.duration) / quantizeGrid),
    );
    const firstMeasure = Math.floor(startStep / gridStepsPerMeasure);
    const lastMeasure = Math.floor((endStep - 1) / gridStepsPerMeasure);
    const sourceId = `${note.track}:${note.channel}:${sourceIndex}:${startStep}`;

    for (
      let measureIndex = firstMeasure;
      measureIndex <= lastMeasure && measureIndex < measures.length;
      measureIndex++
    ) {
      if (measureIndex < 0) continue;
      const measureStartStep = measureIndex * gridStepsPerMeasure;
      const measureEndStep = measureStartStep + gridStepsPerMeasure;
      const segmentStartStep = Math.max(startStep, measureStartStep);
      const segmentEndStep = Math.min(endStep, measureEndStep);
      measures[measureIndex].notes.push({
        sourceId,
        noteNumber: note.noteNumber,
        spelling: note.spelling,
        startTime: segmentStartStep * quantizeGrid,
        endTime: segmentEndStep * quantizeGrid,
        originalStartTime: startStep * quantizeGrid,
        originalEndTime: endStep * quantizeGrid,
        midiStartTime: note.startTime,
        midiEndTime: note.startTime + note.duration,
      });
    }
  });

  return measures;
}

interface RenderedChord {
  note: StaveNote;
  sourceIndexes: Map<string, number>;
  sourceOriginalEndTimes: Map<string, number>;
  startTime: number;
  endTime: number;
}

interface BuiltMeasureVoice {
  voice: Voice;
  staveNotes: (StaveNote | GhostNote)[];
  renderedChords: RenderedChord[];
  tuplets: Tuplet[];
}

interface DetectedTupletGroup {
  id: string;
  sourceIds: Set<string>;
  duration: string;
  numNotes: number;
  notesOccupied: number;
}

interface PositionedChordSource {
  note: StaveNote;
  noteIndex: number;
  endTime: number;
  originalEndTime: number;
  lineIndex: number;
}

interface PendingTie {
  firstNote: StaveNote;
  lastNote: StaveNote;
  firstIndex: number;
  lastIndex: number;
  firstLineIndex: number;
  lastLineIndex: number;
}

/** Split an exact beat span into values VexFlow can render without rounding. */
function splitBeatSpan(
  startBeat: number,
  endBeat: number,
): { duration: string; beats: number }[] {
  const values: { duration: string; beats: number }[] = [
    { duration: 'w', beats: 4 },
    { duration: 'hd', beats: 3 },
    { duration: 'h', beats: 2 },
    { duration: 'qd', beats: 1.5 },
    { duration: 'q', beats: 1 },
    { duration: '8d', beats: 0.75 },
    { duration: '8', beats: 0.5 },
    { duration: '16d', beats: 0.375 },
    { duration: '16', beats: 0.25 },
    { duration: '32', beats: 0.125 },
  ];
  const result: { duration: string; beats: number }[] = [];
  let cursor = startBeat;

  while (endBeat - cursor >= 0.124) {
    // If a note begins off the beat, finish that beat before choosing longer
    // values. This produces conventional ties instead of a half note starting
    // on the last sixteenth of a beat.
    const fraction = cursor - Math.floor(cursor + 0.001);
    const notationBoundary =
      fraction > 0.001 ? Math.min(endBeat, Math.ceil(cursor - 0.001)) : endBeat;
    const remaining = notationBoundary - cursor;
    const chosen =
      values.find((value) => value.beats <= remaining + 0.001) ??
      values[values.length - 1];
    result.push(chosen);
    cursor += chosen.beats;
  }

  return result;
}

/** Detect the 7:6 and 9:8 equal-note tuplets used by the source score. */
function detectTupletGroups(
  measure: Measure,
  secondsPerQuarterNote: number,
): Map<string, DetectedTupletGroup> {
  const bySource = new Map<string, NotationNote>();
  measure.notes.forEach((note) => bySource.set(note.sourceId, note));
  const sourceNotes = [...bySource.values()]
    .filter(
      (note) =>
        note.midiStartTime >= measure.startTime - 0.001 &&
        note.midiEndTime <= measure.endTime + 0.001,
    )
    .sort((a, b) => a.midiStartTime - b.midiStartTime);
  const groupBySource = new Map<string, DetectedTupletGroup>();
  const durationCandidates = [
    { duration: '8', beats: 0.5 },
    { duration: '16', beats: 0.25 },
    { duration: '32', beats: 0.125 },
  ];

  let noteIndex = 0;
  while (noteIndex < sourceNotes.length) {
    let detected: DetectedTupletGroup | undefined;
    for (const numNotes of [9, 7]) {
      const notesOccupied = numNotes - 1;
      const window = sourceNotes.slice(noteIndex, noteIndex + numNotes);
      if (window.length !== numNotes) continue;
      const intervals = window
        .slice(1)
        .map(
          (note, index) => note.midiStartTime - window[index].midiStartTime,
        );
      const averageInterval =
        intervals.reduce((sum, interval) => sum + interval, 0) /
        intervals.length;
      if (
        averageInterval <= 0 ||
        intervals.some(
          (interval) =>
            Math.abs(interval - averageInterval) > averageInterval * 0.08,
        )
      ) {
        continue;
      }
      if (
        window.some(
          (note) =>
            Math.abs(note.midiEndTime - note.midiStartTime - averageInterval) >
            Math.max(0.005, averageInterval * 0.08),
        )
      ) {
        continue;
      }

      const groupStartBeat =
        (window[0].midiStartTime - measure.startTime) /
        secondsPerQuarterNote;
      const groupEndBeat =
        (window[window.length - 1].midiEndTime - measure.startTime) /
        secondsPerQuarterNote;
      // The source score's 9:8 runs occupy one complete beat and its 7:6 run
      // occupies the complete 3/4 bar. Without checking those beat boundaries,
      // the tail of an ordinary 32nd-note group plus the head of a real tuplet
      // can be misidentified as a shifted 9-tuplet (the old m25 corruption).
      if (
        Math.abs(groupStartBeat - Math.round(groupStartBeat)) > 0.02 ||
        Math.abs(groupEndBeat - Math.round(groupEndBeat)) > 0.02
      ) {
        continue;
      }

      const spanBeats =
        (window[window.length - 1].midiEndTime - window[0].midiStartTime) /
        secondsPerQuarterNote;
      const baseBeats = spanBeats / notesOccupied;
      const durationMatch = durationCandidates.find(
        // A real tuplet ratio lands almost exactly on its base note value.
        // Keep this within MIDI tick-rounding error; a broad tolerance turns
        // ordinary runs of nine 16ths or 32nds into false 9:8 tuplets.
        (candidate) => Math.abs(candidate.beats - baseBeats) < 0.005,
      );
      if (!durationMatch) continue;

      detected = {
        id: `${measure.startTime}:${noteIndex}:${numNotes}`,
        sourceIds: new Set(window.map((note) => note.sourceId)),
        duration: durationMatch.duration,
        numNotes,
        notesOccupied,
      };
      detected.sourceIds.forEach((sourceId) =>
        groupBySource.set(sourceId, detected!),
      );
      noteIndex += numNotes;
      break;
    }
    if (!detected) noteIndex++;
  }

  return groupBySource;
}

/**
 * Convert a piano-roll measure to a sequential notation voice.
 *
 * Overlapping MIDI notes are represented as a changing chord at every onset or
 * release boundary. The same source note is then tied between adjacent chord
 * slices. This preserves durations while keeping every tickable inside its bar.
 */
function buildMeasureVoice(
  measure: Measure,
  clef: 'treble' | 'bass',
  bpm: number,
  beatsPerMeasure: number,
  beatValue: number,
  keyNum: number,
  quarterNotesPerMeasure: number,
  noteColor?: string,
): BuiltMeasureVoice {
  const secondsPerQuarterNote = 60 / bpm;
  const boundaries = new Set<number>([0, quarterNotesPerMeasure]);
  const tupletGroupBySource = detectTupletGroups(
    measure,
    secondsPerQuarterNote,
  );
  const rollGroupBySource = new Map<
    string,
    { chordStartBeat: number; sourceIds: Set<string> }
  >();

  // Detect short rolled-chord attacks: staggered notes within one beat that
  // share the same release. Their individual attacks stay single notes, and
  // the accumulated chord begins on the next beat, matching piano engraving.
  const notesByRelease = new Map<number, NotationNote[]>();
  measure.notes.forEach((note) => {
    if (
      note.originalStartTime < measure.startTime - 0.001 ||
      note.originalStartTime >= measure.endTime - 0.001
    ) {
      return;
    }
    const releaseKey = Math.round(note.originalEndTime * 1000);
    const releaseGroup = notesByRelease.get(releaseKey) ?? [];
    releaseGroup.push(note);
    notesByRelease.set(releaseKey, releaseGroup);
  });
  notesByRelease.forEach((releaseGroup) => {
    const uniqueStarts = [
      ...new Set(
        releaseGroup.map((note) => Math.round(note.originalStartTime * 1000)),
      ),
    ].sort((a, b) => a - b);
    if (uniqueStarts.length < 2) return;
    const firstStartTime = uniqueStarts[0] / 1000;
    const lastStartTime = uniqueStarts[uniqueStarts.length - 1] / 1000;
    if (lastStartTime - firstStartTime > secondsPerQuarterNote + 0.001) return;

    const lastStartBeat =
      (lastStartTime - measure.startTime) / secondsPerQuarterNote;
    const chordStartBeat = Math.ceil(lastStartBeat - 0.001);
    if (
      chordStartBeat <= lastStartBeat + 0.001 ||
      chordStartBeat >= quarterNotesPerMeasure
    ) {
      return;
    }
    const sourceIds = new Set(releaseGroup.map((note) => note.sourceId));
    const rollGroup = { chordStartBeat, sourceIds };
    releaseGroup.forEach((note) =>
      rollGroupBySource.set(note.sourceId, rollGroup),
    );
    boundaries.add(chordStartBeat);
  });

  measure.notes.forEach((note) => {
    const isTupletNote = tupletGroupBySource.has(note.sourceId);
    const notationStartTime = isTupletNote
      ? note.midiStartTime
      : note.startTime;
    const notationEndTime = isTupletNote ? note.midiEndTime : note.endTime;
    const startBeat = Math.max(
      0,
      Math.min(
        quarterNotesPerMeasure,
        (notationStartTime - measure.startTime) / secondsPerQuarterNote,
      ),
    );
    const endBeat = Math.max(
      0,
      Math.min(
        quarterNotesPerMeasure,
        (notationEndTime - measure.startTime) / secondsPerQuarterNote,
      ),
    );
    if (isTupletNote) {
      boundaries.add(startBeat);
      boundaries.add(endBeat);
    } else {
      boundaries.add(Math.round(startBeat * 8) / 8);
      boundaries.add(Math.round(endBeat * 8) / 8);
    }
  });

  const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
  const staveNotes: (StaveNote | GhostNote)[] = [];
  const renderedChords: RenderedChord[] = [];
  const tupletNotesByGroup = new Map<
    string,
    { group: DetectedTupletGroup; notes: StaveNote[] }
  >();
  // Accidentals persist for the same staff position until the next barline.
  // Tracking the effective accidental prevents a sustained or repeated pitch
  // from receiving the same modifier on every generated notation slice.
  const accidentalState = new Map<string, EffectiveAccidental>();

  for (
    let boundaryIndex = 0;
    boundaryIndex < sortedBoundaries.length - 1;
    boundaryIndex++
  ) {
    const intervalStart = sortedBoundaries[boundaryIndex];
    const intervalEnd = sortedBoundaries[boundaryIndex + 1];
    if (intervalEnd - intervalStart < 0.01) continue;

    const activeByPitch = new Map<number, NotationNote>();
    measure.notes.forEach((note) => {
      const isTupletNote = tupletGroupBySource.has(note.sourceId);
      const notationStartTime = isTupletNote
        ? note.midiStartTime
        : note.startTime;
      const notationEndTime = isTupletNote ? note.midiEndTime : note.endTime;
      const startBeat =
        (notationStartTime - measure.startTime) / secondsPerQuarterNote;
      const endBeat =
        (notationEndTime - measure.startTime) / secondsPerQuarterNote;
      if (
        startBeat <= intervalStart + 0.001 &&
        endBeat > intervalStart + 0.001
      ) {
        const existing = activeByPitch.get(note.noteNumber);
        // MIDI can retrigger the same pitch before a prior note-off. A stave
        // cannot show duplicate noteheads, so display the most recent attack.
        if (!existing || note.originalStartTime >= existing.originalStartTime) {
          activeByPitch.set(note.noteNumber, note);
        }
      }
    });
    let activeNotes = [...activeByPitch.values()].sort(
      (a, b) => a.noteNumber - b.noteNumber,
    );

    // A rolled chord is commonly encoded as staggered long MIDI notes that all
    // release together. Standard notation shows the individual attacks first,
    // then the accumulated chord on the final attack. Avoid turning each early
    // attack into an increasingly tall chord.
    const intervalStartTime =
      measure.startTime + intervalStart * secondsPerQuarterNote;
    const notesStartingNow = activeNotes.filter(
      (note) => Math.abs(note.originalStartTime - intervalStartTime) < 0.01,
    );
    const rolledAttackNotes = notesStartingNow.filter((note) => {
      const rollGroup = rollGroupBySource.get(note.sourceId);
      return (
        rollGroup !== undefined &&
        intervalStart < rollGroup.chordStartBeat - 0.001
      );
    });
    if (rolledAttackNotes.length > 0) {
      activeNotes = rolledAttackNotes;
    }

    let pieceStart = intervalStart;
    const tupletGroup =
      activeNotes.length === 1
        ? tupletGroupBySource.get(activeNotes[0].sourceId)
        : undefined;
    const pieces = tupletGroup
      ? [
          {
            duration: tupletGroup.duration,
            beats: intervalEnd - intervalStart,
          },
        ]
      : splitBeatSpan(intervalStart, intervalEnd);
    for (const piece of pieces) {
      const pieceEnd = Math.min(intervalEnd, pieceStart + piece.beats);
      if (activeNotes.length === 0) {
        staveNotes.push(new GhostNote({ duration: piece.duration }));
      } else {
        const keys: string[] = [];
        const accidentals: (string | undefined)[] = [];
        const sourceIndexes = new Map<string, number>();
        const sourceOriginalEndTimes = new Map<string, number>();
        activeNotes.forEach((activeNote, noteIndex) => {
          const rollGroup = rollGroupBySource.get(activeNote.sourceId);
          const rollPitchClasses = rollGroup
            ? new Set(
                measure.notes
                  .filter((note) => rollGroup.sourceIds.has(note.sourceId))
                  .map((note) => note.noteNumber % 12),
              )
            : undefined;
          const spellAsBSharp =
            activeNote.noteNumber % 12 === 0 &&
            rollPitchClasses !== undefined &&
            [8, 0, 3, 6].every((pitchClass) =>
              rollPitchClasses.has(pitchClass),
            );
          const { key, effectiveAccidental } = midiToVexFlow(
            activeNote.noteNumber,
            keyNum,
            activeNote.spelling,
            spellAsBSharp ? 'bSharp' : undefined,
          );
          const previousAccidental =
            accidentalState.get(key) ??
            getKeySignatureAccidental(key, keyNum);
          const tiedAcrossBarline =
            pieceStart < 0.001 &&
            activeNote.originalStartTime < measure.startTime - 0.001;
          const accidental =
            !tiedAcrossBarline && effectiveAccidental !== previousAccidental
              ? effectiveAccidental
              : undefined;
          accidentalState.set(key, effectiveAccidental);
          keys.push(key);
          accidentals.push(accidental);
          sourceIndexes.set(activeNote.sourceId, noteIndex);
          sourceOriginalEndTimes.set(
            activeNote.sourceId,
            activeNote.originalEndTime,
          );
        });

        const staveNote = new StaveNote({
          keys,
          duration: piece.duration,
          clef,
          autoStem: true,
        });
        if (piece.duration.endsWith('d')) {
          Dot.buildAndAttach([staveNote], { all: true });
        }
        if (noteColor) {
          staveNote.setStyle({
            fillStyle: noteColor,
            strokeStyle: noteColor,
          });
        }
        accidentals.forEach((accidental, noteIndex) => {
          if (accidental) {
            staveNote.addModifier(new Accidental(accidental), noteIndex);
          }
        });
        staveNotes.push(staveNote);
        if (tupletGroup) {
          const tupletNotes = tupletNotesByGroup.get(tupletGroup.id) ?? {
            group: tupletGroup,
            notes: [],
          };
          tupletNotes.notes.push(staveNote);
          tupletNotesByGroup.set(tupletGroup.id, tupletNotes);
        }
        renderedChords.push({
          note: staveNote,
          sourceIndexes,
          sourceOriginalEndTimes,
          startTime: measure.startTime + pieceStart * secondsPerQuarterNote,
          endTime: measure.startTime + pieceEnd * secondsPerQuarterNote,
        });
      }
      pieceStart = pieceEnd;
    }
  }

  const tuplets = [...tupletNotesByGroup.values()]
    .filter(({ group, notes }) => notes.length === group.numNotes)
    .map(
      ({ group, notes }) =>
        new Tuplet(notes, {
          numNotes: group.numNotes,
          notesOccupied: group.notesOccupied,
          bracketed: false,
          ratioed: false,
          location: 1,
        }),
    );
  const voice = new Voice({ numBeats: beatsPerMeasure, beatValue }).setStrict(
    false,
  );
  voice.addTickables(staveNotes);
  return { voice, staveNotes, renderedChords, tuplets };
}

/** Stored position info for a rendered note */
interface NotePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  startTime: number;
  endTime: number;
}

/**
 * Normalize unusual MIDI time signatures to standard notation.
 * Many MIDI files have incorrectly encoded denominators (e.g., 4/16 instead of 4/4).
 * This function normalizes them to practical values for sheet music display.
 */
function normalizeTimeSignature(
  numerator: number,
  denominator: number,
): { numerator: number; denominator: number } {
  // Many MIDI files have incorrectly encoded time signatures.
  // The MIDI spec stores denominator as a power of 2, so:
  //   denominator=2 means 2^2=4 (quarter notes) - CORRECT for 4/4
  //   denominator=4 means 2^4=16 (sixteenth notes) - WRONG, often meant to be 4/4
  //
  // Common encoding errors to fix:
  //   4/16 → 4/4 (most common error)
  //   3/16 → 3/4
  //   6/16 → 6/8 (compound meter)
  //   2/16 → 2/4
  //   1/256 → likely encoding garbage

  let normNum = numerator;
  let normDenom = denominator;

  // Fix x/16 which is almost always an encoding error
  // Real x/16 time signatures are extremely rare in practice
  if (normDenom === 16) {
    // Check for compound meter patterns (divisible by 3) → convert to /8
    if (normNum % 3 === 0 && normNum >= 6) {
      normDenom = 8; // 6/16 → 6/8, 9/16 → 9/8, 12/16 → 12/8
    } else {
      normDenom = 4; // 4/16 → 4/4, 3/16 → 3/4, 2/16 → 2/4
    }
  }

  // Fix very large denominators (32, 64, 128, 256...)
  // These are almost certainly encoding errors
  while (normDenom > 16) {
    if (normNum % 2 === 0 && normNum > 1) {
      normNum = normNum / 2;
    }
    normDenom = normDenom / 2;
  }

  // After normalization, fix any remaining /16 from the division
  if (normDenom === 16) {
    if (normNum % 3 === 0 && normNum >= 6) {
      normDenom = 8;
    } else {
      normDenom = 4;
    }
  }

  // Ensure denominator is a power of 2 (1, 2, 4, 8)
  const validDenominators = [1, 2, 4, 8];
  if (!validDenominators.includes(normDenom)) {
    normDenom = validDenominators.reduce((prev, curr) =>
      Math.abs(curr - normDenom) < Math.abs(prev - normDenom) ? curr : prev,
    );
  }

  // Ensure numerator is at least 1
  normNum = Math.max(1, Math.round(normNum));

  return { numerator: normNum, denominator: normDenom };
}

/** Track measure data for voice creation */
interface TrackMeasureData {
  track: MidiTrack;
  measures: Measure[];
  clef: 'treble' | 'bass';
}

/**
 * Create voices for a measure without creating staves.
 * Used for calculating minimum widths before layout.
 */
function createVoicesForMeasure(
  trackMeasures: TrackMeasureData[],
  measureIndex: number,
  bpm: number,
  beatsPerMeasure: number,
  beatValue: number,
  keyNum: number,
  quarterNotesPerMeasure: number,
): { voices: Voice[]; trackClefs: ('treble' | 'bass')[] } {
  const voices: Voice[] = [];
  const trackClefs: ('treble' | 'bass')[] = [];

  trackMeasures.forEach(({ measures, clef }) => {
    const measure = measures[measureIndex];
    if (!measure) return;
    voices.push(
      buildMeasureVoice(
        measure,
        clef,
        bpm,
        beatsPerMeasure,
        beatValue,
        keyNum,
        quarterNotesPerMeasure,
      ).voice,
    );
    trackClefs.push(clef);
  });

  return { voices, trackClefs };
}

export function SheetMusic({
  beatsPerMeasure: beatsPerMeasureProp,
}: SheetMusicProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const highlightsRef = useRef<HTMLDivElement>(null);
  const progressLineRef = useRef<HTMLDivElement>(null);
  const [renderedHeight, setRenderedHeight] = useState(0);

  // Store note positions for highlighting
  const notePositionsRef = useRef<NotePosition[]>([]);

  // Track user scrolling to prevent auto-scroll conflict
  const isUserScrolling = useRef(false);
  const scrollTimeout = useRef<number | undefined>(undefined);

  // Store line layout info for scroll-to-seek calculation
  const linesRef = useRef<
    { measureIndices: number[]; cumulativeMeasures: number }[]
  >([]);

  // Store measure positions for click-to-set-loop detection
  const measurePositionsRef = useRef<
    {
      measureIndex: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }[]
  >([]);

  // Subscribe to current file and theme for re-rendering
  const currentFileId = useMidiStore((state) => state.currentFileId);
  const files = useMidiStore((state) => state.files);
  const currentFile = files.find((f) => f.id === currentFileId) || null;
  const theme = useMidiStore((state) => state.settings.theme);
  const seek = useMidiStore((state) => state.seek);
  const loopEnabled = useMidiStore((state) => state.playback.loopEnabled);
  const loopStartMeasure = useMidiStore(
    (state) => state.playback.loopStartMeasure,
  );
  const loopEndMeasure = useMidiStore((state) => state.playback.loopEndMeasure);
  const isPlaying = useMidiStore((state) => state.playback.isPlaying);

  const getPlaybackTime = useCallback(() => {
    return useMidiStore.getState().playback.currentTime;
  }, []);

  // Render sheet music
  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container) return;

    if (!currentFile || currentFile.tracks.length === 0) {
      const existingSvg = container.querySelector('svg');
      if (existingSvg) existingSvg.remove();
      return;
    }

    // Clear previous SVG (but keep progress line)
    const existingSvg = container.querySelector('svg');
    if (existingSvg) existingSvg.remove();

    // Get enabled tracks with notes (including render-only tracks)
    const enabledTracks = currentFile.tracks.filter(
      (t) => (t.enabled || t.renderOnly) && t.notes.length > 0,
    );

    if (enabledTracks.length === 0) {
      setRenderedHeight(0);
      return;
    }

    // Get tempo (use first tempo or default)
    const bpm = currentFile.tempos.length > 0 ? currentFile.tempos[0].bpm : 120;

    // Get time signature from file, normalize unusual denominators
    const rawTimeSignature = currentFile.timeSignature ?? {
      numerator: 4,
      denominator: 4,
    };
    const normalizedTimeSignature = normalizeTimeSignature(
      rawTimeSignature.numerator,
      rawTimeSignature.denominator,
    );
    // Allow prop override for beats per measure, otherwise use file's time signature
    const beatsPerMeasure =
      beatsPerMeasureProp ?? normalizedTimeSignature.numerator;
    const beatValue = normalizedTimeSignature.denominator;

    // Get the initial key signature from the file, or detect it when the MIDI
    // has no explicit key event. Later key changes are applied per measure.
    const allNotes = enabledTracks.flatMap((t) => t.notes);
    // MIDI key value 0 is an explicit C major/A minor signature, not a
    // missing value. Only auto-detect when the file has no key event at all.
    const fallbackKeySignature: KeySignature = currentFile.keySignature ?? {
      key: detectKeySignature(allNotes),
      scale: 0,
    };
    const keySignatureChanges =
      currentFile.keySignatures && currentFile.keySignatures.length > 0
        ? currentFile.keySignatures
        : [{ time: 0, ...fallbackKeySignature }];

    // Group each track's notes into measures
    const trackMeasures: {
      track: MidiTrack;
      measures: Measure[];
      clef: 'treble' | 'bass';
    }[] = enabledTracks.map((track) => ({
      track,
      measures: groupNotesIntoMeasures(
        track.notes,
        currentFile.duration,
        bpm,
        beatsPerMeasure,
        beatValue,
      ),
      clef: getClefForTrack(track.notes),
    }));

    // Calculate quarter notes per measure for layout scaling
    // e.g., 4/4 = 4, 3/4 = 3, 6/8 = 3, 2/4 = 2
    const quarterNotesPerMeasure = beatsPerMeasure * (4 / beatValue);
    const secondsPerQuarterNote = 60 / bpm;
    const keyForMeasure = (measureIndex: number) =>
      keySignatureAtTime(
        keySignatureChanges,
        measureIndex * quarterNotesPerMeasure * secondsPerQuarterNote,
        fallbackKeySignature,
      );

    const measureCount = trackMeasures[0]?.measures.length || 0;

    // Layout constants
    const totalAvailableWidth = 1200;
    const leftMargin = 20;
    const singleStaveHeight = 80;
    const trackSpacing = 20;
    const topMargin = 40;
    const clefKeyTimeWidth = 80; // Extra space for clef, key sig, time sig on first measure of line
    const measurePadding = 20; // Padding between measures

    // ============ FIRST PASS: Calculate each measure's own minimum width ============
    const measureMinWidths = Array(measureCount).fill(40) as number[];
    for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
      const { voices } = createVoicesForMeasure(
        trackMeasures,
        measureIndex,
        bpm,
        beatsPerMeasure,
        beatValue,
        keyForMeasure(measureIndex).key,
        quarterNotesPerMeasure,
      );

      if (voices.length > 0) {
        try {
          const formatter = new Formatter();
          voices.forEach((v) => formatter.joinVoices([v]));
          const minWidth = formatter.preCalculateMinTotalWidth(voices);
          measureMinWidths[measureIndex] = Math.max(40, minWidth);
        } catch {
          // ignore
        }
      }
    }
    // ============ LAYOUT: Pack measures by their actual notation density ============
    const availableWidth =
      totalAvailableWidth - leftMargin * 2 - clefKeyTimeWidth;
    const targetMeasureWidths = measureMinWidths.map((minWidth) =>
      Math.max(80, minWidth + measurePadding),
    );
    const denseMeasureThreshold = availableWidth / 3;
    const lines: number[][] = [];
    let currentLine: number[] = [];
    let currentLineWidth = 0;
    for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
      const targetWidth = targetMeasureWidths[measureIndex];
      const lineContainsDenseMeasure = currentLine.some(
        (index) => targetMeasureWidths[index] >= denseMeasureThreshold,
      );
      const densityLimitReached =
        currentLine.length >= 2 &&
        (lineContainsDenseMeasure || targetWidth >= denseMeasureThreshold);
      if (
        currentLine.length > 0 &&
        (currentLineWidth + targetWidth > availableWidth ||
          densityLimitReached)
      ) {
        lines.push(currentLine);
        currentLine = [];
        currentLineWidth = 0;
      }
      currentLine.push(measureIndex);
      currentLineWidth += targetWidth;
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // Store line info for scroll-to-seek calculation
    let cumulativeMeasures = 0;
    linesRef.current = lines.map((measureIndices) => {
      const result = { measureIndices, cumulativeMeasures };
      cumulativeMeasures += measureIndices.length;
      return result;
    });

    // Height for one "system" (all tracks for one set of measures)
    const systemHeight =
      enabledTracks.length * singleStaveHeight + trackSpacing;
    const lineCount = lines.length;
    const totalHeight = lineCount * systemHeight + topMargin * 2;

    setRenderedHeight(totalHeight);

    // Create renderer
    const renderer = new Renderer(container, Renderer.Backends.SVG);
    renderer.resize(totalAvailableWidth, totalHeight);
    const context = renderer.getContext();
    context.setFont('Arial', 10);

    // Set theme-aware colors for notation elements (matching NotesOverlay exactly)
    const isDark = theme === 'mocha';
    const noteColor = isDark ? '#cdd6f4' : '#4c4f69';
    const staveColor = isDark ? '#6c7086' : '#9ca0b0';
    // Set context defaults for clef rendering
    context.setStrokeStyle(staveColor);
    context.setFillStyle(staveColor);

    // Collect note positions for highlighting
    const notePositions: NotePosition[] = [];
    const measurePositions: {
      measureIndex: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    const pendingTies: PendingTie[] = [];
    const lastChordBySource = new Map<string, PositionedChordSource>();

    // ============ SECOND PASS: Render each line with uniform measure widths ============
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const measureIndices = lines[lineIndex];
      const baseY = topMargin + lineIndex * systemHeight;

      // Preserve each measure's density-based width, then distribute any spare
      // line space proportionally. Dense cadenzas no longer get the same narrow
      // width as a neighboring measure with only a few notes.
      const totalLineWidth = totalAvailableWidth - leftMargin * 2;
      const lineTargetWidth = measureIndices.reduce(
        (sum, index) => sum + targetMeasureWidths[index],
        0,
      );
      const notationLineWidth = totalLineWidth - clefKeyTimeWidth;

      let x = leftMargin;

      for (let posInLine = 0; posInLine < measureIndices.length; posInLine++) {
        const measureIndex = measureIndices[posInLine];
        const isFirstInLine = posInLine === 0;
        const measureKey = keyForMeasure(measureIndex);
        const previousMeasureKey =
          measureIndex > 0 ? keyForMeasure(measureIndex - 1) : measureKey;
        const keyNum = measureKey.key;
        const vexFlowKey = midiKeyToVexFlow(measureKey.key);
        const previousVexFlowKey = midiKeyToVexFlow(previousMeasureKey.key);
        const keyChanged =
          measureIndex > 0 &&
          (measureKey.key !== previousMeasureKey.key ||
            measureKey.scale !== previousMeasureKey.scale);
        // A zero-accidental destination has no visible key signature of its
        // own, so cancel the preceding signature with natural signs.
        const needsKeyCancellation = keyChanged && measureKey.key === 0;

        const densityWidth =
          notationLineWidth *
          (targetMeasureWidths[measureIndex] / lineTargetWidth);
        const staveWidth =
          densityWidth + (isFirstInLine ? clefKeyTimeWidth : 0);

        // Store measure position for click detection
        measurePositions.push({
          measureIndex,
          x,
          y: baseY,
          width: staveWidth,
          height: systemHeight,
        });

        const staves: Stave[] = [];
        const voices: Voice[] = [];
        const voiceData: {
          voice: Voice;
          stave: Stave;
          staveNotes: (StaveNote | GhostNote)[];
          renderedChords: RenderedChord[];
          tuplets: Tuplet[];
          trackIndex: number;
        }[] = [];

        // Create staves and voices for each track
        trackMeasures.forEach(({ measures, clef }, trackIndex) => {
          const y = baseY + trackIndex * singleStaveHeight;
          const measure = measures[measureIndex];

          // Create stave with calculated width
          const stave = new Stave(x, y, staveWidth);
          // Show a one-based measure number once per measure, above the top stave.
          // VexFlow centers it on the measure's left barline, matching standard notation.
          // Do not call setFont() here: it invalidates Stave width metrics in VexFlow 5.
          if (trackIndex === 0) {
            stave.setMeasure(measureIndex + 1);
          }
          if (isFirstInLine) {
            stave.addClef(clef);
            stave.addKeySignature(
              vexFlowKey,
              needsKeyCancellation ? previousVexFlowKey : undefined,
            );
            if (lineIndex === 0) {
              stave.addTimeSignature(`${beatsPerMeasure}/${beatValue}`);
            }
          } else if (keyChanged) {
            stave.addKeySignature(
              vexFlowKey,
              needsKeyCancellation ? previousVexFlowKey : undefined,
            );
          }
          stave.setStyle({ strokeStyle: staveColor, fillStyle: staveColor });
          stave.setContext(context);
          staves.push(stave);
          if (!measure) return;

          const builtVoice = buildMeasureVoice(
            measure,
            clef,
            bpm,
            beatsPerMeasure,
            beatValue,
            keyNum,
            quarterNotesPerMeasure,
            noteColor,
          );
          voices.push(builtVoice.voice);
          voiceData.push({
            voice: builtVoice.voice,
            stave,
            staveNotes: builtVoice.staveNotes,
            renderedChords: builtVoice.renderedChords,
            tuplets: builtVoice.tuplets,
            trackIndex,
          });

          // Connect every uninterrupted source note between adjacent rendered
          // chord slices. The final drawing pass handles system breaks.
          builtVoice.renderedChords.forEach((renderedChord) => {
            renderedChord.sourceIndexes.forEach((noteIndex, sourceId) => {
              const previous = lastChordBySource.get(sourceId);
              if (
                previous &&
                (Math.abs(previous.endTime - renderedChord.startTime) < 0.01 ||
                  previous.originalEndTime >= renderedChord.startTime - 0.01)
              ) {
                pendingTies.push({
                  firstNote: previous.note,
                  lastNote: renderedChord.note,
                  firstIndex: previous.noteIndex,
                  lastIndex: noteIndex,
                  firstLineIndex: previous.lineIndex,
                  lastLineIndex: lineIndex,
                });
              }
              lastChordBySource.set(sourceId, {
                note: renderedChord.note,
                noteIndex,
                endTime: renderedChord.endTime,
                originalEndTime:
                  renderedChord.sourceOriginalEndTimes.get(sourceId) ??
                  renderedChord.endTime,
                lineIndex,
              });
            });
          });
        });

        // Synchronize and draw staves
        if (staves.length > 0) {
          Stave.formatBegModifiers(staves);
          staves.forEach((stave) => stave.draw());
        }

        // Format and draw voices
        if (voices.length > 0) {
          try {
            const noteStartX = staves[0].getNoteStartX();
            const noteEndX = Math.min(...staves.map((s) => s.getNoteEndX()));
            const endPadding = 15; // Padding at end of measure
            const usableWidth = noteEndX - noteStartX - endPadding;

            const formatter = new Formatter({ softmaxFactor: 10 }); // Higher value = tighter spacing
            voices.forEach((v) => formatter.joinVoices([v]));
            formatter.format(voices, Math.max(usableWidth, 20));

            // Voice.draw() normally assigns each tickable's stave, but the
            // beam collision pass below needs note Y positions before drawing.
            voiceData.forEach(({ stave, staveNotes }) =>
              staveNotes.forEach((note) => note.setStave(stave)),
            );

            voiceData.forEach(
              ({
                voice,
                stave,
                staveNotes,
                renderedChords,
                tuplets,
                trackIndex,
              }) => {
              const beamGroups = getBeamGroupsForTimeSignature(
                beatsPerMeasure,
                beatValue,
              );
              const tupletNoteSet = new Set(
                tuplets.flatMap((tuplet) => tuplet.getNotes()),
              );
              const regularBeamSegments: (StaveNote | GhostNote)[][] = [];
              let currentBeamSegment: (StaveNote | GhostNote)[] = [];
              staveNotes.forEach((note) => {
                if (tupletNoteSet.has(note)) {
                  if (currentBeamSegment.length > 0) {
                    regularBeamSegments.push(currentBeamSegment);
                    currentBeamSegment = [];
                  }
                } else {
                  currentBeamSegment.push(note);
                }
              });
              if (currentBeamSegment.length > 0) {
                regularBeamSegments.push(currentBeamSegment);
              }
              const beams = regularBeamSegments.flatMap((segment) =>
                Beam.generateBeams(segment, {
                  groups: beamGroups,
                  // A rising run can cross the stave midpoint inside one beat.
                  // Let the beam choose one group stem direction; preserving
                  // each auto-stem direction splits m25's 32nds into 2 + 6.
                  maintainStemDirections: false,
                }),
              );
              const tupletBeams = tuplets.map((tuplet) => {
                const notes = tuplet.getNotes() as StaveNote[];
                // First give the whole group one automatic stem direction.
                // If that puts its beam into a nearby adjacent stave, flip the
                // group outward. High notes with enough inter-stave room keep
                // their natural downward stems, so they do not hit the system
                // above (as happened in m26).
                let beam = new Beam(notes, true);
                const direction = beam.getStemDirection();
                const minX = Math.min(
                  ...notes.map((note) => note.getAbsoluteX()),
                );
                const maxX = Math.max(
                  ...notes.map((note) => note.getAbsoluteX()),
                );
                const adjacentTrackIndex =
                  direction === Stem.DOWN ? trackIndex + 1 : trackIndex - 1;
                const adjacentNotes =
                  voiceData[adjacentTrackIndex]?.staveNotes.filter(
                    (note): note is StaveNote =>
                      note instanceof StaveNote &&
                      note.getAbsoluteX() >= minX - 8 &&
                      note.getAbsoluteX() <= maxX + 8,
                  ) ?? [];
                if (adjacentNotes.length > 0) {
                  const groupTop = Math.min(
                    ...notes.flatMap((note) => note.getYs()),
                  );
                  const groupBottom = Math.max(
                    ...notes.flatMap((note) => note.getYs()),
                  );
                  const adjacentTop = Math.min(
                    ...adjacentNotes.flatMap((note) => note.getYs()),
                  );
                  const adjacentBottom = Math.max(
                    ...adjacentNotes.flatMap((note) => note.getYs()),
                  );
                  const interStaveGap =
                    direction === Stem.DOWN
                      ? adjacentTop - groupBottom
                      : groupTop - adjacentBottom;
                  if (interStaveGap < 90) {
                    const outwardDirection =
                      direction === Stem.DOWN ? Stem.UP : Stem.DOWN;
                    notes.forEach((note) =>
                      note.setStemDirection(outwardDirection),
                    );
                    beam = new Beam(notes);
                  }
                }
                // Put the number on the beam side, just as standard engraving
                // does: low runs above, very high runs below.
                tuplet.setTupletLocation(beam.getStemDirection());
                return beam;
              });
              voice.draw(context, stave);
              [...beams, ...tupletBeams].forEach((beam) => {
                beam.setStyle({ fillStyle: noteColor, strokeStyle: noteColor });
                beam.setContext(context).draw();
              });
              tuplets.forEach((tuplet) => {
                tuplet.setStyle({
                  fillStyle: noteColor,
                  strokeStyle: noteColor,
                });
                tuplet.setContext(context).draw();
              });

              renderedChords.forEach((renderedChord) => {
                try {
                  const noteX = renderedChord.note.getAbsoluteX();
                  const bb = renderedChord.note.getBoundingBox();
                  if (bb) {
                    notePositions.push({
                      x: noteX,
                      y: bb.getY(),
                      width: 20,
                      height: bb.getH(),
                      startTime: renderedChord.startTime,
                      endTime: renderedChord.endTime,
                    });
                  }
                } catch {
                  /* ignore */
                }
              });
              },
            );
          } catch {
            /* ignore formatting errors */
          }
        }

        // Draw connectors
        if (isFirstInLine && staves.length > 1) {
          try {
            const connector = new StaveConnector(
              staves[0],
              staves[staves.length - 1],
            );
            connector.setType('brace');
            connector.setStyle({
              strokeStyle: staveColor,
              fillStyle: staveColor,
            });
            connector.setContext(context).draw();
            const lineConnector = new StaveConnector(
              staves[0],
              staves[staves.length - 1],
            );
            lineConnector.setType('singleLeft');
            lineConnector.setStyle({
              strokeStyle: staveColor,
              fillStyle: staveColor,
            });
            lineConnector.setContext(context).draw();
          } catch {
            /* ignore */
          }
        }

        if (staves.length > 1) {
          try {
            const endConnector = new StaveConnector(
              staves[0],
              staves[staves.length - 1],
            );
            endConnector.setType('singleRight');
            endConnector.setStyle({
              strokeStyle: staveColor,
              fillStyle: staveColor,
            });
            endConnector.setContext(context).draw();
          } catch {
            /* ignore */
          }
        }

        x += staveWidth;
      }
    }

    // Ties are drawn after every stave has been formatted. A tie crossing a
    // system break is rendered as two conventional partial ties at line ends.
    pendingTies.forEach((tieData) => {
      try {
        const tieStyle = {
          fillStyle: noteColor,
          strokeStyle: noteColor,
        };
        if (tieData.firstLineIndex === tieData.lastLineIndex) {
          const tie = new StaveTie({
            firstNote: tieData.firstNote,
            lastNote: tieData.lastNote,
            firstIndexes: [tieData.firstIndex],
            lastIndexes: [tieData.lastIndex],
          });
          tie.setStyle(tieStyle);
          tie.setContext(context).draw();
        } else {
          const outgoingTie = new StaveTie({
            firstNote: tieData.firstNote,
            firstIndexes: [tieData.firstIndex],
          });
          outgoingTie.setStyle(tieStyle);
          outgoingTie.setContext(context).draw();

          const incomingTie = new StaveTie({
            lastNote: tieData.lastNote,
            lastIndexes: [tieData.lastIndex],
          });
          incomingTie.setStyle(tieStyle);
          incomingTie.setContext(context).draw();
        }
      } catch {
        /* ignore malformed ties */
      }
    });

    // Store note positions for highlighting
    notePositionsRef.current = notePositions;

    // Store measure positions for loop click detection
    measurePositionsRef.current = measurePositions;

    // Store layout info for progress tracking
    const secondsPerMeasure = (60 / bpm) * beatsPerMeasure * (4 / beatValue);
    container.dataset.measureCount = String(measureCount);
    container.dataset.systemHeight = String(systemHeight);
    container.dataset.leftMargin = String(leftMargin);
    container.dataset.topMargin = String(topMargin);
    container.dataset.secondsPerMeasure = String(secondsPerMeasure);
    container.dataset.trackCount = String(enabledTracks.length);
    container.dataset.singleStaveHeight = String(singleStaveHeight);
    container.dataset.lineCount = String(lines.length);
  }, [currentFile, beatsPerMeasureProp, theme]);

  // Scroll-to-seek: convert scroll position to playback time (only when paused)
  const handleScroll = useCallback(() => {
    // Only seek when playback is paused - don't interfere with auto-scroll during playback
    const isPlaying = useMidiStore.getState().playback.isPlaying;
    if (isPlaying) return;

    const container = containerRef.current;
    const svgContainer = svgContainerRef.current;
    if (!container || !svgContainer || !currentFile) return;

    // Mark as user scrolling to prevent auto-scroll conflict
    isUserScrolling.current = true;
    clearTimeout(scrollTimeout.current);
    scrollTimeout.current = window.setTimeout(() => {
      isUserScrolling.current = false;
    }, 150);

    // Get layout info from dataset
    const systemHeight = parseFloat(svgContainer.dataset.systemHeight || '0');
    const topMargin = parseFloat(svgContainer.dataset.topMargin || '0');
    const secondsPerMeasure = parseFloat(
      svgContainer.dataset.secondsPerMeasure || '0',
    );

    if (systemHeight === 0 || secondsPerMeasure === 0) return;

    const scrollTop = container.scrollTop;

    // Calculate which line is at the scroll position
    const lineIndex = Math.max(
      0,
      Math.floor((scrollTop - topMargin + systemHeight / 2) / systemHeight),
    );

    // Get measure info from linesRef
    const lines = linesRef.current;
    if (lineIndex >= lines.length) return;

    const lineInfo = lines[lineIndex];
    const measureIndex = lineInfo.cumulativeMeasures;

    // Calculate time from measure index
    const time = measureIndex * secondsPerMeasure;

    // Clamp to valid range
    const maxTime = currentFile.duration;
    seek(Math.max(0, Math.min(time, maxTime)));
  }, [currentFile, seek]);

  // Attach scroll listener
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Highlight active notes and auto-scroll
  useEffect(() => {
    const container = containerRef.current;
    const highlights = highlightsRef.current;
    if (!container || !highlights) return;

    let animationId: number;
    let lastLineIndex = -1;

    const updateHighlights = () => {
      if (!currentFile) {
        animationId = requestAnimationFrame(updateHighlights);
        return;
      }

      const currentTime = getPlaybackTime();
      const notePositions = notePositionsRef.current;

      // Clear existing highlights
      highlights.innerHTML = '';

      // Find and highlight active notes
      for (const pos of notePositions) {
        if (currentTime >= pos.startTime && currentTime < pos.endTime) {
          const highlight = document.createElement('div');
          highlight.className = styles.noteHighlight;
          highlight.style.left = `${pos.x - 4}px`;
          highlight.style.top = `${pos.y - 4}px`;
          highlight.style.width = `${pos.width + 8}px`;
          highlight.style.height = `${pos.height + 8}px`;
          highlights.appendChild(highlight);
        }
      }

      // Update progress line position
      const progressLine = progressLineRef.current;
      if (progressLine) {
        const svgContainer = svgContainerRef.current;
        if (svgContainer) {
          const secondsPerMeasure = parseFloat(
            svgContainer.dataset.secondsPerMeasure || '0',
          );
          const measurePositions = measurePositionsRef.current;

          if (secondsPerMeasure > 0 && measurePositions.length > 0) {
            // Find current measure index
            const currentMeasure = Math.floor(currentTime / secondsPerMeasure);
            const fractionInMeasure =
              (currentTime % secondsPerMeasure) / secondsPerMeasure;

            // Find the measure position
            const measurePos = measurePositions.find(
              (m) => m.measureIndex === currentMeasure,
            );
            if (measurePos) {
              // Calculate x position within the measure
              const xPos = measurePos.x + fractionInMeasure * measurePos.width;
              progressLine.style.left = `${xPos}px`;
              progressLine.style.top = `${measurePos.y}px`;
              progressLine.style.height = `${measurePos.height}px`;
              progressLine.style.display = 'block';
            } else {
              progressLine.style.display = 'none';
            }
          } else {
            progressLine.style.display = 'none';
          }
        }
      }

      // Auto-scroll based on current measure (not note Y position)
      if (!isUserScrolling.current) {
        const svgContainer = svgContainerRef.current;
        if (svgContainer) {
          const systemHeight = parseFloat(
            svgContainer.dataset.systemHeight || '0',
          );
          const topMargin = parseFloat(svgContainer.dataset.topMargin || '0');
          const secondsPerMeasure = parseFloat(
            svgContainer.dataset.secondsPerMeasure || '0',
          );

          if (systemHeight > 0 && secondsPerMeasure > 0) {
            // Calculate current measure from time
            const currentMeasure = Math.floor(currentTime / secondsPerMeasure);

            // Find which line contains this measure
            const lines = linesRef.current;
            let lineIndex = 0;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].measureIndices.includes(currentMeasure)) {
                lineIndex = i;
                break;
              }
              // If measure is past this line's measures, keep looking
              if (
                i < lines.length - 1 &&
                currentMeasure >
                  lines[i].measureIndices[lines[i].measureIndices.length - 1]
              ) {
                lineIndex = i + 1;
              }
            }

            // Only scroll when we move to a different line
            if (lineIndex !== lastLineIndex) {
              lastLineIndex = lineIndex;
              const scrollTarget = topMargin + lineIndex * systemHeight;
              container.scrollTo({
                top: Math.max(0, scrollTarget),
                behavior: 'smooth',
              });
            }
          }
        }
      }

      animationId = requestAnimationFrame(updateHighlights);
    };

    animationId = requestAnimationFrame(updateHighlights);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [currentFile, getPlaybackTime, renderedHeight]);

  // Calculate loop overlay positions
  const loopOverlays = useMemo(() => {
    if (!loopEnabled || loopStartMeasure === null || loopEndMeasure === null)
      return [];

    const overlays: { x: number; y: number; width: number; height: number }[] =
      [];
    const measurePositions = measurePositionsRef.current;

    for (const pos of measurePositions) {
      if (
        pos.measureIndex >= loopStartMeasure &&
        pos.measureIndex <= loopEndMeasure
      ) {
        overlays.push({
          x: pos.x,
          y: pos.y,
          width: pos.width,
          height: pos.height,
        });
      }
    }
    return overlays;
  }, [loopEnabled, loopStartMeasure, loopEndMeasure, renderedHeight]);

  // Calculate scroll snap points for each line
  const snapPoints = useMemo(() => {
    const svgContainer = svgContainerRef.current;
    if (!svgContainer || renderedHeight === 0) return [];

    const systemHeight = parseFloat(svgContainer.dataset.systemHeight || '0');
    const topMargin = parseFloat(svgContainer.dataset.topMargin || '0');
    const lineCount = parseInt(svgContainer.dataset.lineCount || '0', 10);

    if (systemHeight === 0 || lineCount === 0) return [];

    const points: number[] = [];
    for (let i = 0; i < lineCount; i++) {
      points.push(topMargin + i * systemHeight);
    }
    return points;
  }, [renderedHeight]);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={
        isPlaying ? { overflow: 'hidden', scrollSnapType: 'none' } : undefined
      }
    >
      <div ref={svgContainerRef} className={styles.svgContainer}>
        <div ref={highlightsRef} className={styles.highlights} />
        <div ref={progressLineRef} className={styles.progressLine} />
        {/* Scroll snap points for each line */}
        {snapPoints.map((y, i) => (
          <div
            key={`snap-${i}`}
            className={styles.snapPoint}
            style={{ top: y }}
          />
        ))}
        {/* Loop range overlay */}
        {loopOverlays.map((overlay, i) => (
          <div
            key={i}
            className={styles.loopOverlay}
            style={{
              left: overlay.x,
              top: overlay.y,
              width: overlay.width,
              height: overlay.height,
            }}
          />
        ))}
      </div>
    </div>
  );
}
