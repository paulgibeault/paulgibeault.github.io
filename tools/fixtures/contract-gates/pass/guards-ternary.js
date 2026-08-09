// The plain guarded read. Shipped verbatim by three fleet repos in their own
// js/ trees; the receiver is the literal Arcade.settings in each.
export function powerSaving() {
  return Arcade.settings.powerSaver ? Arcade.settings.powerSaver() : false;
}

// The same idiom as an object property rather than a return — a third repo's
// snapshot builder writes it this way.
export const snapshot = () => ({
  powerSaver: Arcade.settings.powerSaver ? Arcade.settings.powerSaver() : false,
});
