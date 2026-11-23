// Browsers trust localhost over HTTP as well as HTTPS. Rely on their secure
// context check so local preview gets the same offline shell as production.
export function registerAppServiceWorker(browserWindow = window, browserNavigator = navigator) {
  if (!browserWindow.isSecureContext || !browserNavigator.serviceWorker) return Promise.resolve(null)
  return browserNavigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => null)
}
