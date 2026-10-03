// dsh-select-ask — the route guard's own test.
//
// `isTrustedRequest` is pure over request headers, so the decision that stands
// between a paid model call and any caller can be checked without a server:
//
//   node --test plugins/dsh-select-ask/test/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isTrustedRequest } from '../host.js';

const TOKEN = 'token-from-index';
const HOST = '127.0.0.1:19387';

test('armed: only the exact token passes', () => {
  const armed = { token: TOKEN, tokenArmed: true };
  assert.equal(isTrustedRequest({ host: HOST, 'x-dsh-select-ask': TOKEN }, armed), true);
  assert.equal(isTrustedRequest({ host: HOST, 'x-dsh-select-ask': 'other' }, armed), false);
  assert.equal(isTrustedRequest({ host: HOST }, armed), false);
  assert.equal(isTrustedRequest({}, armed), false);
});

test('unarmed: our own origin passes', () => {
  const open = { token: TOKEN, tokenArmed: false };
  assert.equal(
    isTrustedRequest({ host: HOST, origin: `http://${HOST}` }, open),
    true,
  );
  assert.equal(
    isTrustedRequest({ host: HOST, host_alias: undefined, referer: `http://${HOST}/?token=abc` }, open),
    true,
  );
});

test('unarmed: a foreign browser origin is refused', () => {
  const open = { token: TOKEN, tokenArmed: false };
  assert.equal(isTrustedRequest({ host: HOST, origin: 'https://evil.example' }, open), false);
  assert.equal(isTrustedRequest({ host: HOST, referer: 'https://evil.example/page' }, open), false);
  assert.equal(isTrustedRequest({ origin: 'https://evil.example' }, open), false);
});

test('unarmed: a headerless local caller passes, malformed headers do not', () => {
  const open = { token: TOKEN, tokenArmed: false };
  assert.equal(isTrustedRequest({ host: HOST }, open), true);
  assert.equal(isTrustedRequest({ host: HOST, origin: 'not a url' }, open), false);
  assert.equal(isTrustedRequest({ host: HOST, origin: '' }, open), true);
});
