import { defineConfig } from '@tarojs/cli';
import path from 'node:path';

const dataMode = process.env.TARO_APP_DATA_MODE || 'demo';
const apiBaseUrl = (process.env.TARO_APP_API_BASE_URL || '').replace(/\/$/, '');
if (dataMode !== 'live' && dataMode !== 'demo') throw new Error('TARO_APP_DATA_MODE 必须为 live 或 demo');
if (dataMode === 'live' && !/^https:\/\//.test(apiBaseUrl)) throw new Error('真实数据构建须设置 HTTPS TARO_APP_API_BASE_URL');

export default defineConfig({
  projectName: 'xiaoke-miniapp',
  date: '2026-09-18',
  designWidth: 375,
  deviceRatio: { 375: 2 },
  sourceRoot: 'src',
  outputRoot: dataMode === 'live' ? `dist/${process.env.TARO_ENV}` : `dist/demo/${process.env.TARO_ENV}`,
  framework: 'react',
  compiler: 'vite',
  alias: { '@share': path.resolve(__dirname, `../src/services/share.${process.env.TARO_ENV}.ts`) },
  plugins: ['@tarojs/plugin-platform-weapp', '@tarojs/plugin-platform-h5'],
  defineConstants: {
    'process.env.TARO_APP_DATA_MODE': JSON.stringify(dataMode),
    'process.env.TARO_APP_API_BASE_URL': JSON.stringify(apiBaseUrl || 'http://127.0.0.1:4180'),
  },
  mini: {
    postcss: { htmltransform: { enable: false }, pxtransform: { enable: true }, cssModules: { enable: false } },
  },
  h5: {
    publicPath: '/',
    router: { mode: 'hash' },
    devServer: { host: '127.0.0.1', port: 4173 },
    postcss: { pxtransform: { enable: true }, cssModules: { enable: false } },
  },
});
