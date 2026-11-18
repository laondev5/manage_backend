// Evaluate the real deployment artifact, not only the lazy server.js wrapper.
// Importing the Express app does not initialize MongoDB or send notifications.
import assert from 'node:assert/strict';

const { default: app } = await import('../dist/serverless.js');
assert.equal(typeof app, 'function', 'Serverless bundle must export an Express app');
assert.equal(typeof app.use, 'function', 'Serverless export must support Express middleware');
console.log('Serverless bundle import passed');
