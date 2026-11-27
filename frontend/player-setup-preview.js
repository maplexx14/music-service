// Isolate preview storage before loading stores, which subscribe to every update.
// This also keeps the Vite preview from changing settings on the app's origin.
function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => { values.set(String(key), String(value)) },
    removeItem: (key) => { values.delete(String(key)) },
    clear: () => values.clear(),
  }
}
Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true })
Object.defineProperty(window, 'sessionStorage', { value: memoryStorage(), configurable: true })
void import('./player-setup-preview.jsx')
