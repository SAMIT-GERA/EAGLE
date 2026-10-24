import { startUploadServer } from '../tests/support/uploadHarness.js';

const app = await startUploadServer(undefined, 3001);
process.stdout.write(`OFFLINE_BROWSER_AUDIT_ORIGIN=${app.origin}\n`);
const close = () => { void app.close().finally(() => process.exit()); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
