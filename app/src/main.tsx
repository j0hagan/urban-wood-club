import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminReview from './AdminReview'
import './styles.css'

// No router dependency for a single extra page - just branch on the path.
const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAdmin ? <AdminReview /> : <App />}
  </React.StrictMode>
)
