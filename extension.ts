import { foldedRanges } from "@codemirror/language";
import {
  EditorState,
  Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  ViewUpdate,
  lineNumberMarkers,
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

/**
 * Obsidian's Vim adapter. `view.cm` is set by codemirror-vim; the plugin walk
 * covers builds that don't hang the adapter off the view.
 */
function vimAdapter(view: EditorView): any {
  const anyView = view as any;
  if (anyView.cm?.state?.vim || anyView.cm?.on) return anyView.cm;
  const plugins = anyView.plugins;
  if (!Array.isArray(plugins)) return null;
  for (const plugin of plugins) {
    const value = plugin?.value ?? plugin;
    if (!value) continue;
    if ("useNextTextInput" in value && "waitForCopy" in value && value.cm) return value.cm;
    if (value.cm?.state?.vim) return value.cm;
  }
  return null;
}

function isInsertMode(view: EditorView): boolean {
  return Boolean(vimAdapter(view)?.state?.vim?.insertMode);
}

class NumberMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof NumberMarker && other.text === this.text;
  }

  toDOM() {
    return document.createTextNode(this.text);
  }
}

/** Hidden lines strictly inside folds, as a prefix sum. prefix[n] = hidden lines in 1..n. */
function hiddenPrefix(state: EditorState): Uint32Array {
  const lines = state.doc.lines;
  const hidden = new Uint8Array(lines + 1);
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    const start = state.doc.lineAt(from).number;
    const end = state.doc.lineAt(to).number;
    for (let n = start + 1; n <= end && n <= lines; n++) hidden[n] = 1;
  });
  const prefix = new Uint32Array(lines + 1);
  for (let n = 1; n <= lines; n++) prefix[n] = prefix[n - 1] + hidden[n];
  return prefix;
}

function buildMarkers(state: EditorState, cursor: number, absolute: boolean): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const lines = state.doc.lines;
  const width = String(lines).length;
  const prefix = absolute ? null : hiddenPrefix(state);
  const safeCursor = Math.min(Math.max(1, cursor), lines);

  for (let n = 1; n <= lines; n++) {
    let text: string;
    if (absolute || n === safeCursor) {
      text = String(n).padStart(width, " ");
    } else {
      const lo = Math.min(n, safeCursor);
      const hi = Math.max(n, safeCursor);
      const folded = prefix![hi - 1] - prefix![lo];
      text = String(Math.max(0, hi - lo - folded)).padStart(width, " ");
    }
    const pos = state.doc.line(n).from;
    // Point marker at the line start. The built-in gutter draws it in that
    // line's cell and skips its own absolute number when the marker has toDOM.
    builder.add(pos, pos, new NumberMarker(text));
  }
  return builder.finish();
}

function remapLine(tr: Transaction, line: number): number {
  const safe = Math.min(Math.max(1, line), tr.startState.doc.lines);
  const pos = tr.changes.mapPos(tr.startState.doc.line(safe).from, 1);
  return tr.state.doc.lineAt(pos).number;
}

interface Snapshot {
  cursor: number;
  absolute: boolean;
  markers: RangeSet<GutterMarker>;
}

/**
 * One column, drawn inside Obsidian's existing line-number gutter.
 * Insert (and replace) mode: absolute. Every other mode: relative, with the
 * cursor line kept absolute so you can still read it.
 */
export function lineNumbersRelative(getDebounce: () => number = () => 0): Extension {
  const setSnapshot = StateEffect.define<{ cursor: number; absolute: boolean }>();

  const numbersField = StateField.define<Snapshot>({
    create(state) {
      const cursor = state.doc.lineAt(state.selection.main.head).number;
      return { cursor, absolute: false, markers: buildMarkers(state, cursor, false) };
    },
    update(value, tr) {
      let cursor = value.cursor;
      let absolute = value.absolute;
      let forced = false;

      for (const effect of tr.effects) {
        if (effect.is(setSnapshot)) {
          cursor = effect.value.cursor;
          absolute = effect.value.absolute;
          forced = true;
        }
      }

      const delay = delayOf(getDebounce);
      if (!forced && delay === 0 && !absolute && (tr.selection || tr.docChanged)) {
        cursor = tr.state.doc.lineAt(tr.state.selection.main.head).number;
        forced = true;
      } else if (!forced && tr.docChanged) {
        cursor = remapLine(tr, cursor);
        forced = true;
      }

      if (!forced) return value;
      if (cursor === value.cursor && absolute === value.absolute && !tr.docChanged) return value;
      return { cursor, absolute, markers: buildMarkers(tr.state, cursor, absolute) };
    },
    provide: (field) => lineNumberMarkers.from(field, (snapshot) => snapshot.markers),
  });

  const sync = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private queued = false;
      private dead = false;
      private vimCm: any = null;
      readonly flush: () => void;
      private readonly onVimMode: () => void;

      constructor(readonly view: EditorView) {
        this.flush = () => {
          if (this.dead) return;
          const absolute = isInsertMode(view);
          const cursor = view.state.doc.lineAt(view.state.selection.main.head).number;
          const snap = view.state.field(numbersField);
          if (snap.absolute === absolute && snap.cursor === cursor) return;
          view.dispatch({ effects: setSnapshot.of({ cursor, absolute }) });
        };
        this.onVimMode = () => {
          this.clearTimer();
          this.queueFlush();
        };
        flushers.add(this.flush);
        this.attachVim(view);
        this.queueFlush();
      }

      update(update: ViewUpdate) {
        if (this.dead) return;
        this.attachVim(update.view);
        const absolute = isInsertMode(update.view);
        const snap = update.state.field(numbersField);

        if (absolute !== snap.absolute) {
          this.clearTimer();
          this.queueFlush();
          return;
        }
        // Absolute labels don't depend on the cursor.
        if (absolute) return;

        const cursor = update.state.doc.lineAt(update.state.selection.main.head).number;
        if (cursor === snap.cursor) {
          this.clearTimer();
          return;
        }
        // Delay 0 is applied inside the selection transaction.
        if (delayOf(getDebounce) === 0) return;

        this.clearTimer();
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, delayOf(getDebounce));
      }

      private attachVim(view: EditorView) {
        const cm = vimAdapter(view);
        if (cm === this.vimCm) return;
        if (this.vimCm?.off) this.vimCm.off("vim-mode-change", this.onVimMode);
        this.vimCm = cm;
        if (cm?.on) cm.on("vim-mode-change", this.onVimMode);
      }

      private queueFlush() {
        if (this.queued || this.dead) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          this.flush();
        });
      }

      private clearTimer() {
        if (this.timer != null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
      }

      destroy() {
        this.dead = true;
        this.clearTimer();
        if (this.vimCm?.off) this.vimCm.off("vim-mode-change", this.onVimMode);
        flushers.delete(this.flush);
      }
    },
  );

  return [numbersField, sync];
}
