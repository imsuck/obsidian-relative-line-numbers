import { Plugin } from "obsidian";
import { Extension } from "@codemirror/state";
import { flushRelativeLineNumbers, lineNumbersRelative } from "./extension";
import {
  DEFAULT_SETTINGS,
  RelativeLineNumbersSettings,
  RelativeLineNumbersSettingTab,
} from "./settings";

export default class RelativeLineNumbers extends Plugin {
  private editorExtension: Extension[] = [];
  private debounceTimers = new Map<CodeMirror.Editor, ReturnType<typeof setTimeout>>();
  /** Registered once. `registerCodeMirror` cannot be undone, so enable/disable must not call it again. */
  private legacyHooked = false;

  settings: RelativeLineNumbersSettings = DEFAULT_SETTINGS;
  enabled = false;

  isLegacy() {
    return (this.app as any).vault.config?.legacyEditor;
  }

  private delayMs() {
    const value = Number(this.settings?.debounce);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new RelativeLineNumbersSettingTab(this.app, this));
    this.registerEditorExtension(this.editorExtension);

    // @ts-ignore internal config
    if (this.app.vault.getConfig("showLineNumber")) {
      this.enable();
    }

    this.setupConfigChangeListener();
    this.addCommand({
      id: "toggle-relative-line-numbers",
      name: "Toggle Relative Line Numbers",
      callback: () => {
        // @ts-ignore internal config — read live; the value at load time goes stale
        if (!this.app.vault.getConfig("showLineNumber")) return;
        if (this.enabled) this.disable();
        else this.enable();
      },
    });
  }

  onunload() {
    this.clearAllDebounceTimers();
    this.disable();
    this.detachLegacyListeners();
  }

  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData()),
    };
  }

  async updateSettings(updates: Partial<RelativeLineNumbersSettings>) {
    this.settings = { ...this.settings, ...updates };
    await this.saveData(this.settings);
    // Delay is read live by the CM6 extension. Only a drop to 0 needs an immediate paint.
    if (this.delayMs() === 0) {
      this.flushDebounceTimers();
      flushRelativeLineNumbers();
    }
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;

    if (this.isLegacy()) {
      this.legacyEnable();
      return;
    }

    this.editorExtension.length = 0;
    // Getter, not a snapshot — the debounce slider must apply to editors already open.
    this.editorExtension.push(lineNumbersRelative(() => this.delayMs()));
    this.app.workspace.updateOptions();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.clearAllDebounceTimers();

    if (this.isLegacy()) {
      this.legacyRestoreFormatters();
      return;
    }

    this.editorExtension.length = 0;
    this.app.workspace.updateOptions();
  }

  legacyEnable() {
    if (!this.legacyHooked) {
      this.legacyHooked = true;
      this.registerCodeMirror((cm: CodeMirror.Editor) => {
        cm.on("cursorActivity", this.legacyRelativeLineNumbers);
        const onMode = () => this.legacyRelativeLineNumbers(cm);
        (cm as any).state.relativeModeHook = onMode;
        (cm as any).on?.("vim-mode-change", onMode);
      });
    }
    this.app.workspace.iterateCodeMirrors((cm: CodeMirror.Editor) => {
      this.updateLegacyLineNumbers(cm, cm.getCursor().line + 1);
    });
  }

  legacyRestoreFormatters() {
    this.app.workspace.iterateCodeMirrors((cm: CodeMirror.Editor) => {
      cm.state.relativeActive = false;
      cm.state.relativeLine = undefined;
      cm.state.relativeAbsolute = undefined;
      cm.setOption(
        "lineNumberFormatter",
        // @ts-ignore CM5 global
        CodeMirror.defaults["lineNumberFormatter"],
      );
      (cm as any).refresh?.();
    });
  }

  detachLegacyListeners() {
    if (!this.legacyHooked) return;
    this.app.workspace.iterateCodeMirrors((cm: CodeMirror.Editor) => {
      cm.off("cursorActivity", this.legacyRelativeLineNumbers);
      const onMode = (cm as any).state?.relativeModeHook;
      if (onMode) (cm as any).off?.("vim-mode-change", onMode);
    });
  }

  setupConfigChangeListener() {
    // @ts-ignore vault event
    const configChangedEvent = this.app.vault.on("config-changed", () => {
      // @ts-ignore internal config
      const showLineNumber: boolean = this.app.vault.getConfig("showLineNumber");
      if (showLineNumber && !this.enabled) this.enable();
      else if (!showLineNumber && this.enabled) this.disable();
    });
    // @ts-ignore associate with this plugin for unload on older builds
    configChangedEvent.ctx = this;
    this.registerEvent(configChangedEvent);
  }

  legacyRelativeLineNumbers = (cm: CodeMirror.Editor) => {
    if (!this.enabled) return;

    const delay = this.delayMs();
    if (delay === 0) {
      this.clearDebounceTimer(cm);
      this.updateLegacyLineNumbers(cm, cm.getCursor().line + 1);
      return;
    }

    this.clearDebounceTimer(cm);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(cm);
      if (!this.enabled) return;
      this.updateLegacyLineNumbers(cm, cm.getCursor().line + 1);
    }, delay);
    this.debounceTimers.set(cm, timer);
  };

  private legacyIsAbsolute(cm: CodeMirror.Editor): boolean {
    const vim = (cm as any).state?.vim;
    if (vim) return Boolean(vim.insertMode);
    const keyMap = (cm as any).getOption?.("keyMap");
    return keyMap === "vim-insert" || keyMap === "vim-replace";
  }

  private updateLegacyLineNumbers(cm: CodeMirror.Editor, current: number) {
    const absolute = this.legacyIsAbsolute(cm);
    // Same line AND our formatter still installed. After disable/enable,
    // `relativeLine` can still match while the formatter was restored to absolute.
    if (
      cm.state.relativeLine === current &&
      cm.state.relativeAbsolute === absolute &&
      cm.state.relativeActive
    ) {
      return;
    }

    cm.state.relativeLine = current;
    cm.state.relativeAbsolute = absolute;
    cm.state.relativeActive = true;
    cm.setOption("lineNumberFormatter", (line: number) => {
      if (absolute || line === current) return String(line);
      return String(Math.abs(current - line));
    });
    // CM5 does not redraw when `lineNumberFormatter` changes. Inside
    // cursorActivity the gutter has often already been painted, and a
    // debounced update runs even later — without refresh() the numbers stick.
    (cm as any).refresh?.();
  }

  private clearDebounceTimer(cm: CodeMirror.Editor) {
    const timer = this.debounceTimers.get(cm);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.debounceTimers.delete(cm);
    }
  }
  private clearAllDebounceTimers() {
    Array.from(this.debounceTimers.values()).forEach((timer) => {
      clearTimeout(timer);
    });
    this.debounceTimers.clear();
  }
  private flushDebounceTimers() {
    Array.from(this.debounceTimers.keys()).forEach((cm) => {
      this.clearDebounceTimer(cm);
      if (this.enabled) {
        this.updateLegacyLineNumbers(cm, cm.getCursor().line + 1);
      }
    });
  }
}
