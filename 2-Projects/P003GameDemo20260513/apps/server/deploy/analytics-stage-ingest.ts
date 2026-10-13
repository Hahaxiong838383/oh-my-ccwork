// Same app factory and environment adapter as production, isolated loopback port.
import { serve } from '@hono/node-server';
import { createAnalyticsApp, analyticsOptionsFromEnv } from '../src/analytics/index.js';
serve({fetch:createAnalyticsApp(analyticsOptionsFromEnv()).fetch,hostname:'127.0.0.1',port:3306});
