import { createTaskGateServer } from './server.js';

const portValue = process.env.PORT ?? '3000';
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be a valid TCP port number.');
}
const operatorPin = process.env.OPERATOR_PIN?.trim();
if (!operatorPin) {
  throw new Error('OPERATOR_PIN must be configured before starting TaskGate.');
}

const server = await createTaskGateServer({
  operatorPin,
  grantTemplate: {
    taskId: 'demo-task',
    version: 'v1',
    confirmed: false,
    approvedFileIds: ['quote-A', 'quote-B'],
    permittedTools: ['read_quote', 'send_clarification_email'],
    prohibitedOperations: ['delete', 'modify'],
    eligibleRecipients: ['supplier@example.test'],
    approvalEligibleTools: ['send_clarification_email']
  }
});

const listener = server.app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`TaskGate dashboard listening at http://127.0.0.1:${port}\n`);
});

async function shutdown() {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  await server.close();
}

process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
