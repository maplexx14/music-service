// Keep lazy player modules lazy at runtime, but include their files in the
// service worker's self-contained shell before committing a new index.html.
export function offlineUiAssets(bundle) {
  const roots = ['pages/Home.jsx', 'pages/Playlists.jsx', 'pages/PlaylistDetail.jsx', 'pages/ExternalPlaylist.jsx', 'pages/LinkPlaylist.jsx', 'pages/LikedSongs.jsx', 'pages/Search.jsx', 'pages/Artist.jsx', 'pages/Album.jsx', 'components/FullScreenPlayer.jsx', 'utils/cdDeckScene.js', 'components/Grainient.jsx']
  const files = new Set(['/cd-player-frames/manifest.json'])
  const visited = new Set()
  const visit = (name) => {
    if (visited.has(name)) return
    visited.add(name)
    const chunk = bundle[name]
    if (!chunk || chunk.type !== 'chunk') return
    files.add(`/${chunk.fileName}`)
    for (const file of chunk.viteMetadata?.importedCss || []) files.add(`/${file}`)
    for (const file of chunk.viteMetadata?.importedAssets || []) files.add(`/${file}`)
    for (const file of chunk.imports) visit(file)
  }
  for (const chunk of Object.values(bundle)) {
    if (chunk.type === 'chunk' && roots.some((root) => chunk.facadeModuleId?.replace(/\\/g, '/').endsWith(`/src/${root}`))) visit(chunk.fileName)
  }
  return [...files].sort()
}

export function offlineUiManifest() {
  return {
    name: 'bolt-offline-player-assets',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      this.emitFile({ type: 'asset', fileName: 'offline-ui.json', source: JSON.stringify(offlineUiAssets(bundle)) })
    },
  }
}
