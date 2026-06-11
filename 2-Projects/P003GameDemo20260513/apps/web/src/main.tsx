import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { KidsHubApp } from './kidshub/KidsHubApp';
import './styles.css';

// 工作台分流：/kidshub-ai 路径，或 kidshub-ai.* 专属域名（公网 kidshub-ai.hahaxiong.cc
// 根路径直接进工作台）；其余 = 原 demo（p003.hahaxiong.cc 不受影响，同一份 dist 双域名共用）
const isKidsHub =
  window.location.pathname.startsWith('/kidshub-ai') ||
  window.location.hostname.startsWith('kidshub-ai.');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isKidsHub ? <KidsHubApp /> : <App />}</React.StrictMode>,
);
