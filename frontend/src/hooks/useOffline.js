import { useSyncExternalStore } from 'react'
import { isOffline, subscribeConnectivity } from '../services/connectivity'

export const useOffline = () => useSyncExternalStore(subscribeConnectivity, isOffline, () => false)
