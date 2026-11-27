import { useSyncExternalStore } from 'react'
import { isPowerSave, onPowerSaveChange } from '../utils/powerSave'

// Режим энергосбережения устройства (utils/powerSave) как состояние React.
export function usePowerSave() {
  return useSyncExternalStore(onPowerSaveChange, isPowerSave)
}
