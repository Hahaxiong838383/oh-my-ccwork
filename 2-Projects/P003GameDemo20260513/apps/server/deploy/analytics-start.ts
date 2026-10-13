// PM2 imports the app through ProcessContainerFork; it is not the CLI main module.
import {analyticsOptionsFromEnv,startAnalyticsServer} from '../src/analytics/index.js';

let options:ReturnType<typeof analyticsOptionsFromEnv>|undefined;
try {
  options=analyticsOptionsFromEnv();
  startAnalyticsServer(options);
  console.log('[analytics] LISTENING_3006');
} catch {
  options?.store.close();
  console.error('[analytics] STARTUP_CONFIGURATION_ERROR');
  process.exitCode=1;
}
