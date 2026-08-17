"""Note <-> MIDI <-> ToneDecoder-hex mapping, and the empirical F# tuning table.

ToneDecoder (qurihara.github.io/ToneDecoder) decodes a blown tone by:
    frequency -> nearest MIDI note number -> 2-digit uppercase hex
and concatenates the hex of each stable note into a password string.
So a "password" is just a MIDI-note sequence written in hex.

This module is the single source of truth for that mapping, kept byte-compatible
with ToneDecoder's auth.html so a physical flute we generate here will decode to
exactly the password string we intend.
"""
from __future__ import annotations
import csv
import os
import re

NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

DATA_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "data")


def note_to_midi(note: str) -> int:
    """'F#5' -> 78 (MIDI). Octave -1..9, C4 = 60 (Yamaha/MIDI standard)."""
    m = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d+)", note.strip())
    if not m:
        raise ValueError(f"bad note: {note!r}")
    letter, acc, octave = m.group(1).upper(), m.group(2), int(m.group(3))
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[letter]
    base += {"": 0, "#": 1, "b": -1}[acc]
    return base + 12 * (octave + 1)


def midi_to_note(midi: int) -> str:
    """78 -> 'F#5'."""
    return f"{NOTE_NAMES_SHARP[midi % 12]}{midi // 12 - 1}"


def note_to_freq(note: str) -> float:
    """'F#5' -> 739.99 Hz（平均律, A4=440Hz）。"""
    return 440.0 * 2.0 ** ((note_to_midi(note) - 69) / 12.0)


def midi_to_hex(midi: int) -> str:
    """78 -> '4E'  (ToneDecoder: roundedMidiNum.toString(16).toUpperCase().padStart(2,'0'))."""
    return format(midi, "02X")


def note_to_hex(note: str) -> str:
    return midi_to_hex(note_to_midi(note))


def hex_to_notes(phrase: str) -> list[str]:
    """'5558564F' -> ['C#6','E6','D6','G5']  (inverse of the ToneDecoder encoding)."""
    phrase = phrase.strip().upper()
    if len(phrase) % 2:
        raise ValueError("hex phrase must have even length")
    return [midi_to_note(int(phrase[i:i + 2], 16)) for i in range(0, len(phrase), 2)]


def notes_to_hex(notes: list[str]) -> str:
    return "".join(note_to_hex(n) for n in notes)


def load_tuning(path: str | None = None) -> list[dict]:
    """Load the empirical F# tuning table (note -> printed tube length + stl filename)."""
    path = path or os.path.join(DATA_DIR, "tuning_fsharp.csv")
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["length_outside"] = float(r["length_outside"])
        r["length_inside"] = float(r["length_inside"])
        r["midi"] = note_to_midi(r["note"])
    return rows


def tuning_by_note(path: str | None = None) -> dict[str, dict]:
    return {r["note"]: r for r in load_tuning(path)}


# The tuning table only covers F#5..F#6. When a target melody note falls outside
# that octave, fold it into the playable octave (keep pitch class).
def fold_into_range(note: str, lo="F#5", hi="F#6") -> str:
    lo_m, hi_m, m = note_to_midi(lo), note_to_midi(hi), note_to_midi(note)
    while m < lo_m:
        m += 12
    while m > hi_m:
        m -= 12
    return midi_to_note(m)


if __name__ == "__main__":
    # self-check against the ToneDecoder README example: pass=5558564F
    assert hex_to_notes("5558564F") == ["C#6", "E6", "D6", "G5"], hex_to_notes("5558564F")
    assert note_to_hex("C4") == "3C" and note_to_hex("F#5") == "4E"
    assert notes_to_hex(["C#6", "E6", "D6", "G5"]) == "5558564F"
    # default ToneDecoder phrase = C major scale C4..B4
    assert hex_to_notes("3C3E4041434547") == ["C4", "D4", "E4", "F4", "G4", "A4", "B4"]
    tbl = tuning_by_note()
    assert set(tbl) >= {"F#5", "C6", "F#6"}
    print("notes.py self-check OK")
    print(" F#5 tube =", tbl["F#5"]["length_inside"], "mm  midi", tbl["F#5"]["midi"])
    print(" password 5558564F ->", hex_to_notes("5558564F"))
