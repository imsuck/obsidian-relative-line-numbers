import { foldedRanges } from "@codemirror/language";
import {
  EditorState,
  Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  ViewUpdate,
  gutter,
  gutters,
} from "@codemirror/view";

const flushers = new Set<() => void>();

/** Repaint debounced gutters immediately (used when the delay is set to 0). */
export function flushRelativeLineNumbers() {
  for (const flush of Array.from(flushers)) flush();
}

function delayOf(getDebounce: () => number): number {
  const value = Number(getDebounce());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hiddenBetween(state: EditorState, lineNo: number, cursorLine: number): number {
  if (lineNo === cursorLine) return 0;
  const fromLine = Math.min(lineNo, cursorLine);
  const toLine = Math.max(lineNo, cursorLine);
  const start = state.doc.line(fromLine).from;
  const stop = state.doc.line(toLine).from;
  let hidden = 0;
  foldedRanges(state).between(start, stop, (from, to) => {
    hidden += state.doc.lineAt(to).number - state.doc.lineAt(from).number;
  });
  return hidden;
}

function labelFor(state: EditorState, lineNo: number, cursorLine: number): string {
  const width = String(state.doc.lines).length;
  if (lineNo === cursorLine) return String(lineNo).padStart(width, " ");
  const distance = Math.max(0, Math.abs(cursorLine - lineNo) - hiddenBetween(state, lineNo, cursorLine));
  return String(distance).padStart(width, " ");
}

class RelativeMarker extends GutterMarker {
  elementClass = "relative-line-numbers-mono";

  constructor(readonly text: string) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof RelativeMarker && other.text === this.text;
  }

  toDOM() {
    return document.createTextNode(this.text);
  }
}

/**
 * Vim-style hybrid numbers: absolute on the cursor line, relative elsewhere.
 * `getDebounce` is read live so the settings slider applies without reinstalling.
 *
 * Line markers are NOT rebuilt by CodeMirror when only the selection changes.
 * A cursor-line state field is what makes `lineMarkerChange` true. With delay 0
 * that field updates inside the original selection transaction (no extra
 * dispatch — those fight Vim mode). With a delay, a view plugin commits the
 * line after the user pauses.
 */
export function lineNumbersRelative(getDebounce: () => number = () => 0): Extension {
  const setCursorLine = StateEffect.define<number>();

  const cursorLineField = StateField.define<number>({
    create(state) {
      return state.doc.lineAt(state.selection.main.head).number;
    },
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setCursorLine)) return effect.value;
      }
      if (delayOf(getDebounce) === 0 && (tr.selection || tr.docChanged)) {
        return tr.state.doc.lineAt(tr.state.selection.main.head).number;
      }
      if (tr.docChanged) {
        const safe = Math.min(Math.max(1, value), tr.startState.doc.lines);
        const mapped = tr.changes.mapPos(tr.startState.doc.line(safe).from, 1);
        return tr.state.doc.lineAt(mapped).number;
      }
      return value;
    },
  });

  const relativeGutter = gutter({
    class: "cm-relativeLineNumbers",
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const cursorLine = view.state.field(cursorLineField);
      return new RelativeMarker(labelFor(view.state, lineNo, cursorLine));
    },
    lineMarkerChange(update) {
      return (
        update.docChanged ||
        update.startState.field(cursorLineField) !== update.state.field(cursorLineField) ||
        foldedRanges(update.startState) !== foldedRanges(update.state)
      );
    },
    initialSpacer(view) {
      return new RelativeMarker("0".repeat(String(view.state.doc.lines).length));
    },
    updateSpacer(spacer, update) {
      const text = "0".repeat(String(update.view.state.doc.lines).length);
      return spacer instanceof RelativeMarker && spacer.text === text
        ? spacer
        : new RelativeMarker(text);
    },
  });

  const debounceCursor = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private dead = false;
      readonly flush: () => void;

      constructor(readonly view: EditorView) {
        this.flush = () => {
          if (this.dead) return;
          this.clear();
          const line = view.state.doc.lineAt(view.state.selection.main.head).number;
          if (view.state.field(cursorLineField) !== line) {
            view.dispatch({ effects: setCursorLine.of(line) });
          }
        };
        flushers.add(this.flush);
      }

      update(update: ViewUpdate) {
        if (this.dead) return;
        const delay = delayOf(getDebounce);
        if (delay === 0) {
          this.clear();
          return;
        }
        if (!update.selectionSet && !update.docChanged) return;
        const line = update.state.doc.lineAt(update.state.selection.main.head).number;
        if (update.state.field(cursorLineField) === line) {
          this.clear();
          return;
        }
        this.clear();
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, delay);
      }

      clear() {
        if (this.timer != null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
      }

      destroy() {
        this.dead = true;
        this.clear();
        flushers.delete(this.flush);
      }
    },
  );

  return [
    cursorLineField,
    gutters(),
    relativeGutter,
    debounceCursor,
    // Hides Obsidian's own absolute gutter while this extension is active.
    // Removed with the extension when relative numbers are toggled off.
    EditorView.editorAttributes.of({ class: "relative-line-numbers-active" }),
  ];
}
