import { Plugin } from "obsidian";
import { lineNumbersRelative } from "./extension";
import { Extension } from "@codemirror/state";
import {
  DEFAULT_SETTINGS,
  RelativeLineNumbersSettings,
  RelativeLineNumbersSettingTab,
} from "./settings";

export default class RelativeLineNumbers extends Plugin {
  private editorExtension: Extension[] = [];
  private debounceTimers = new Map<
    CodeMirror.Editor,
    ReturnType<typeof setTimeout>
  >();

  settings: RelativeLineNumbersSettings = DEFAULT_SETTINGS;
  enabled = false;

  isLegacy() {
    return (this.app as any).vault.config?.legacyEditor;
  }

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new RelativeLineNumbersSettingTab(this.app, this));

    this.registerEditorExtension(this.editorExtension);

    // @ts-ignore
    const showLineNumber: boolean = this.app.vault.getConfig("showLineNumber");

    if (showLineNumber) {
      this.enable();
    }

    this.setupConfigChangeListener();

    this.addCommand({
      id: "toggle-relative-line-numbers",
      name: "Toggle Relative Line Numbers",
      callback: () => {
        // @ts-ignore
        if (!this.app.vault.getConfig("showLineNumber")) {
          return;
        }

        if (this.enabled) {
          this.disable();
        } else {
          this.enable();
        }
      },
    });
  }

  onunload() {
    this.clearAllDebounceTimers();
    this.disable();
  }

  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData()),
    };
  }

  async updateSettings(updates: Partial<RelativeLineNumbersSettings>) {
    this.settings = {
      ...this.settings,
      ...updates,
    };

    await this.saveData(this.settings);

    // Apply the new threshold immediately to pending legacy updates.
    if (this.settings.debounce === 0) {
      this.flushDebounceTimers();
    }
  }

  enable() {
    if (this.enabled) {
      return;
    }

    this.enabled = true;

    if (this.isLegacy()) {
      this.legacyEnable();
    } else {
      this.editorExtension.length = 0;
      this.editorExtension.push(lineNumbersRelative());
      this.app.workspace.updateOptions();
    }
  }

  disable() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.clearAllDebounceTimers();

    if (this.isLegacy()) {
      this.legacyDisable();
    } else {
      this.editorExtension.length = 0;
      this.app.workspace.updateOptions();
    }
  }

  legacyEnable() {
    this.registerCodeMirror((cm) => {
      cm.on("cursorActivity", this.legacyRelativeLineNumbers);
    });
  }

  legacyDisable() {
    this.app.workspace.iterateCodeMirrors((cm) => {
      cm.off("cursorActivity", this.legacyRelativeLineNumbers);

      // Restore the default formatter.
      cm.setOption(
        "lineNumberFormatter",
        // @ts-ignore
        CodeMirror.defaults["lineNumberFormatter"],
      );
    });
  }

  setupConfigChangeListener() {
    // @ts-ignore
    const configChangedEvent = this.app.vault.on("config-changed", () => {
      const showLineNumber: boolean =
        // @ts-ignore
        this.app.vault.getConfig("showLineNumber");

      if (showLineNumber && !this.enabled) {
        this.enable();
      } else if (!showLineNumber && this.enabled) {
        this.disable();
      }
    });

    // @ts-ignore
    configChangedEvent.ctx = this;
    this.registerEvent(configChangedEvent);
  }

  legacyRelativeLineNumbers = (cm: CodeMirror.Editor) => {
    if (!this.enabled) {
      return;
    }

    const current = cm.getCursor().line + 1;
    const delay = Math.max(0, this.settings.debounce);

    // No debounce: update immediately.
    if (delay === 0) {
      this.clearDebounceTimer(cm);
      this.updateLegacyLineNumbers(cm, current);
      return;
    }

    // Replace the previous pending update for this editor.
    this.clearDebounceTimer(cm);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(cm);

      if (this.enabled) {
        const latestLine = cm.getCursor().line + 1;
        this.updateLegacyLineNumbers(cm, latestLine);
      }
    }, delay);

    this.debounceTimers.set(cm, timer);
  };

  private updateLegacyLineNumbers(cm: CodeMirror.Editor, current: number) {
    if (cm.state.curLineNum === current) {
      return;
    }

    cm.state.curLineNum = current;

    cm.setOption("lineNumberFormatter", (line: number) => {
      if (line === current) {
        return String(current);
      }

      return String(Math.abs(current - line));
    });
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
