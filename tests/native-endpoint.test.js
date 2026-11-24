import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('PLAN 23: execute production Java endpoint with synthetic monotonic time', (t) => {
  const exe = (name) => process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const probe = spawnSync(exe('javac'), ['-version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') { t.skip('JDK unavailable; native endpoint needs a JDK'); return; }
  assert.equal(probe.status, 0, probe.stderr);
  const out = mkdtempSync(join(tmpdir(), 'voicefit-endpoint-'));
  try {
    const sources = ['../android/app/src/main/java/com/voicefit/app/SpeechEndpoint.java', './java/SpeechEndpointCheck.java']
      .map((p) => fileURLToPath(new URL(p, import.meta.url)));
    const compile = spawnSync(exe('javac'), ['-encoding', 'UTF-8', '-d', out, ...sources], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(exe('java'), ['-cp', out, 'com.voicefit.app.SpeechEndpointCheck'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /passed/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
