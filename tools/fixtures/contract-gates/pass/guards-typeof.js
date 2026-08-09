// The typeof form, spanning three lines. The guard and the call it protects sit
// in different lines of one expression, so a line-scoped gate cannot see them
// together — this is why Gate C reads a window, not a line.
function readPowerSaver() {
  return !!(Arcade.settings
    && typeof Arcade.settings.powerSaver === 'function'
    && Arcade.settings.powerSaver());
}

let powerSaving = readPowerSaver();
export { readPowerSaver, powerSaving };
