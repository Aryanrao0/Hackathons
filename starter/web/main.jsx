import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AcceptInvite from './components/AcceptInvite.jsx';
import './styles.css';

// Two entry points on one page: an invite link (/invite/<token>) is handled before any
// session exists; everything else is the console.
function Root() {
  const match = /^\/invite\/([^/]+)\/?$/.exec(window.location.pathname);
  if (match) return <AcceptInvite token={decodeURIComponent(match[1])} />;
  return <App />;
}

createRoot(document.getElementById('root')).render(<Root />);
