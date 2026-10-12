import { App, PluginSettingTab, Setting } from "obsidian";
import RelativeLineNumbers from "./main";

export interface RelativeLineNumbersSettings {
  debounce: number;
}

export const DEFAULT_SETTINGS: RelativeLineNumbersSettings = {
  debounce: 100,
};

export class RelativeLineNumbersSettingTab extends PluginSettingTab {
  plugin: RelativeLineNumbers;

  constructor(app: App, plugin: RelativeLineNumbers) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Debounce delay")
      .setDesc(
        "Delay in milliseconds before updating relative line numbers. Set to 0 to disable debouncing."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 500, 10)
          .setValue(this.plugin.settings.debounce)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              debounce: value,
            });
          })
      );
  }
}
