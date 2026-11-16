import { createServer } from 'node:http';
import { createBffHandler } from './app';
import { loadServerConfig } from './config';
import { log } from './logger';

const config = loadServerConfig();
const server = createServer(createBffHandler(config));

server.listen(config.port, config.host, () => log('info', 'server_started', { host: config.host, port: config.port, ccBaseUrl: config.ccBaseUrl }));
