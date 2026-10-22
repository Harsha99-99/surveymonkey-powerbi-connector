const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { listSurveys } = require('../src/core/surveymonkey');
const { isPortOpen } = require('../src/core/runner');

const API = 'https://api.surveymonkey.com/v3';

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('lists surveys across pages and sends the token only as a bearer header', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    if (url === `${API}/surveys?per_page=100`) {
      return response(200, {
        data: [{ id: 1, title: 'First', response_count: 3 }],
        links: { next: `${API}/surveys?per_page=100&page=2` },
      });
    }
    return response(200, { data: [{ id: 2, title: 'Second' }], links: {} });
  };

  const surveys = await listSurveys('tok-123456789', fetchImpl);
  assert.deepEqual(surveys, [
    { id: '1', title: 'First', responseCount: 3 },
    { id: '2', title: 'Second', responseCount: null },
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.auth === 'Bearer tok-123456789'));
  assert.ok(calls.every((c) => !c.url.includes('tok-123456789')));
});

test('a rejected token gives a plain-language message', async () => {
  await assert.rejects(listSurveys('bad-token-xx', async () => response(401, {})), /did not accept this token/);
});

test('a next link pointing anywhere but the SurveyMonkey API is not followed', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(200, { data: [], links: { next: 'https://example.com/steal' } });
  };
  await listSurveys('tok-123456789', fetchImpl);
  assert.equal(calls, 1);
});

test('isPortOpen tells an open port from a closed one', async () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  assert.equal(await isPortOpen(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortOpen(port), false);
});
