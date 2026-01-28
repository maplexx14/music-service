import Sidebar from './Sidebar'
import Player from './Player'
import './Layout.css'

function Layout({ children }) {
  return (
    <div className="layout">
      <Sidebar />
      <main className="main-content">
        {children}
      </main>
      <Player />
    </div>
  )
}

export default Layout
