/**
 * A single keystroke captured during recording. `label` is the display string
 * for the main key (e.g. "A", "Enter", "←"); modifier state is captured
 * separately so the renderer can lay out combos as distinct keycaps.
 *
 * Modifier-only keypresses are NOT recorded — they're only meaningful as
 * decorations on a following non-modifier press, and recording them would
 * spam the overlay during normal typing.
 */
export interface KeystrokeEvent {
	timeMs: number;
	label: string;
	modifiers: {
		ctrl: boolean;
		alt: boolean;
		shift: boolean;
		meta: boolean;
	};
}

/**
 * Map a uiohook-napi keycode to a human-readable label. uiohook exposes
 * `UiohookKey` constants; we mirror the common subset here so the renderer
 * doesn't need to depend on the native module. Unknown keycodes return null
 * (caller drops them rather than showing "Key147").
 */
export function labelForKeycode(keycode: number): string | null {
	// Letters (A-Z)
	if (keycode >= 30 && keycode <= 55) {
		return LETTERS[keycode];
	}
	// Numbers (0-9, top row)
	if (NUMBER_ROW[keycode]) return NUMBER_ROW[keycode];
	// Function keys (F1-F12)
	if (keycode >= 59 && keycode <= 68) return `F${keycode - 58}`;
	if (keycode === 87) return "F11";
	if (keycode === 88) return "F12";

	return NAMED[keycode] ?? null;
}

/**
 * True for keycodes that are modifier-only presses (Ctrl, Shift, Alt, Meta).
 * These should NOT be recorded as standalone keystrokes — they appear as
 * decorations on the next non-modifier press via the modifiers field.
 */
export function isModifierKeycode(keycode: number): boolean {
	return MODIFIER_KEYCODES.has(keycode);
}

// uiohook-napi keycode mappings. Numbers match the UiohookKey enum from
// the published d.ts. Verified against
// https://github.com/SnosMe/uiohook-napi/blob/master/src/keycodes.ts
const LETTERS: Record<number, string> = {
	30: "A",
	48: "B",
	46: "C",
	32: "D",
	18: "E",
	33: "F",
	34: "G",
	35: "H",
	23: "I",
	36: "J",
	37: "K",
	38: "L",
	50: "M",
	49: "N",
	24: "O",
	25: "P",
	16: "Q",
	19: "R",
	31: "S",
	20: "T",
	22: "U",
	47: "V",
	17: "W",
	45: "X",
	21: "Y",
	44: "Z",
};

const NUMBER_ROW: Record<number, string> = {
	2: "1",
	3: "2",
	4: "3",
	5: "4",
	6: "5",
	7: "6",
	8: "7",
	9: "8",
	10: "9",
	11: "0",
};

const NAMED: Record<number, string> = {
	1: "Esc",
	14: "Backspace",
	15: "Tab",
	28: "Enter",
	57: "Space",
	72: "↑",
	80: "↓",
	75: "←",
	77: "→",
	71: "Home",
	79: "End",
	73: "PgUp",
	81: "PgDn",
	82: "Insert",
	83: "Delete",
	// Punctuation (most-used)
	12: "-",
	13: "=",
	26: "[",
	27: "]",
	39: ";",
	40: "'",
	41: "`",
	43: "\\",
	51: ",",
	52: ".",
	53: "/",
};

const MODIFIER_KEYCODES = new Set<number>([
	29, // Ctrl (left)
	3613, // Ctrl (right)
	42, // Shift (left)
	54, // Shift (right)
	56, // Alt (left)
	3640, // Alt (right)
	3675, // Meta/Win/Cmd (left)
	3676, // Meta/Win/Cmd (right)
]);
