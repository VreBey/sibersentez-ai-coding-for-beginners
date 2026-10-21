// tools/audit-electron.mjs: only an advisory against Electron itself fails the check, not the build tools' known ones
// (independent review of 0.20.0); and the Tests workflow runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtimeAdvisories, isAuditReport } from '../tools/audit-electron.mjs';

test('an advisory against electron is reported with its titles; @electron/get and the build tools are not', () => {
  const report = {
    vulnerabilities: {
      electron: { severity: 'high', via: [{ title: 'Heap overflow in a codec', url: 'https://example.invalid/1' }, 'some-dep'] },
      '@electron/get': { severity: 'moderate', via: ['global-agent'] },
      'electron-builder': { severity: 'moderate', via: ['app-builder-lib'] },
    },
  };
  assert.deepEqual(runtimeAdvisories(report), [{ name: 'electron', severity: 'high', titles: ['Heap overflow in a codec'] }]);
  assert.deepEqual(runtimeAdvisories({ vulnerabilities: { 'electron-builder': { severity: 'moderate', via: [] } } }), []);
  assert.deepEqual(runtimeAdvisories(null), []);
  assert.deepEqual(runtimeAdvisories({ vulnerabilities: { electron: null } }), []);
  // Listed only because a dependency is affected (@electron/get, install time only): not Electron's own advisory
  assert.deepEqual(runtimeAdvisories({ vulnerabilities: { electron: { severity: 'moderate', via: ['@electron/get'] } } }), []);
});

test('a failed request is no audit: npm prints an error JSON without vulnerabilities, which must not pass as none found', () => {
  // As npm 11 prints it with an unreachable registry
  const failed = { message: 'request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9', error: { summary: '', detail: '' } };
  assert.equal(isAuditReport(failed), false);
  assert.equal(isAuditReport(null), false);
  assert.equal(isAuditReport({ vulnerabilities: {} }), false, 'no metadata');
  assert.equal(isAuditReport({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: {} } }), true);
});

test('the Tests workflow runs it after the audit of what ships', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  const a = yml.indexOf('npm audit --omit=dev');
  const b = yml.indexOf('node tools/audit-electron.mjs');
  assert.ok(a > 0 && b > a, 'both steps, the Electron one after');
});
