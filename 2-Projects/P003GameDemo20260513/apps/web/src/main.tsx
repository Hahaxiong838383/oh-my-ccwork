import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { KidsHubApp } from './kidshub/KidsHubApp';
import './styles.css';

// /kidshub-ai = Prompt 体验工作台；其余路径 = 原 demo（互不影响）
const isKidsHub = window.location.pathname.startsWith('/kidshub-ai');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isKidsHub ? <KidsHubApp /> : <App />}</React.StrictMode>,
);
