/* An unguarded read. On a repo carrying a vendored pre-3.13 SDK this throws
   TypeError — and because it sits inside an onSettingsChange handler, it throws
   on every launcher settings write, not once at startup. */
export function applyPowerSaver() {
  const saving = Arcade.settings.powerSaver();
  document.documentElement.dataset.saving = String(saving);
}

Arcade.onSettingsChange(applyPowerSaver);
