// Which 3D model each ship type uses. The table is generated from EVE's public
// API by scripts/build-ship-models.mjs.
import shipModels from './shipModels.json'

/** The model "DNA" (hull:faction:race) for a ship type, if it has one. */
export const dnaFor = (shipTypeID: number): string | undefined => (shipModels as Record<string, string>)[String(shipTypeID)]
