// Production bootstrap, shared checkpoint and shutdown; isolated loopback port only.
import {startAnalyticsServer,analyticsOptionsFromEnv} from '../src/analytics/index.js';
startAnalyticsServer(analyticsOptionsFromEnv(),3306);
