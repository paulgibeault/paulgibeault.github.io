// Guarded through an ALIASED receiver. The literal `Arcade.settings.powerSaver`
// never appears at the call site, so a gate keyed on that string rejects this
// perfectly correct code — which is what the one pre-existing copy of Gate C
// did to four of the five adopters it was pointed at.
export function powerSaving(settings) {
  const s = settings;
  return !!(s && s.powerSaver && s.powerSaver());
}
