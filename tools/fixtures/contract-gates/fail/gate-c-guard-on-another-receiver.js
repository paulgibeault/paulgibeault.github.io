/* The guard is real, but it guards the WRONG object: `other` is checked and
   `Arcade.settings` is called. A gate that just looks for the word "powerSaver"
   near a call would be satisfied. */
export function saving(other) {
  if (other.powerSaver && other.powerSaver) {
    return Arcade.settings.powerSaver();
  }
  return false;
}
