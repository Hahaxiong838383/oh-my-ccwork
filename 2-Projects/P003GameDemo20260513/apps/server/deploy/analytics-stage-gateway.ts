// Isolated HTTP harness with the actual production authentication/admin/config routes.
// Use fake credentials and temporary cwd/data only. No voice entry or persona timer.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { authRoute } from '../src/routes/auth.js';
import { adminDataRoute } from '../src/routes/admin-data.js';
import { deviceConfigRoute } from '../src/routes/device-config.js';
const app = new Hono();
app.get('/health', c => c.json({ status: 'ok', stage: true }));
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);
app.route('/v1/device/config', deviceConfigRoute);
app.use('/admin/*', serveStatic({root:'../web/public'}));
app.get('/admin', c => c.redirect('/admin/'));
serve({fetch:app.fetch,hostname:'127.0.0.1',port:3005});
