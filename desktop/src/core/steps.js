/**
 * steps.js
 *
 * Runs one manifest step. Everything that touches the machine (running a
 * command, starting a background process, probing a port, calling the
 * connector, reading files) comes in through `ctx`, so the step logic is
 * testable with fakes and the real implementation lives in runner.js.
 *
 * Commands run exactly as written in the manifest, with two exceptions that
 * mirror what a person following the README would do:
 *   - `cd <dir>` changes the working folder for the rest of the step.
 *   - `git clone` and the settings `Copy-Item` are skipped when their result
 *     already exists, so running a step twice is safe.
 */

const path = require('node:path');
const { expandCommands } = require('./manifest');
const { evaluateTool } = require('./checks');
const { applySettings } = require('./settings');

const CONNECTOR = 'http://localhost:7071';
const CD = /^cd\s+(.+)$/i;
const GIT_CLONE = /^git clone\s+(\S+)/i;
const COPY_SETTINGS = /^Copy-Item\s+local\.settings\.json\.example\s+local\.settings\.json$/i;

const done = (message) => ({ ok: true, message });
const fail = (message) => ({ ok: false, message });

async function runStep(step, ctx) {
  try {
    if (step.tools) return await runTools(step, ctx);
    if (step.open) {
      ctx.log(`Opening ${step.open}`);
      await ctx.openUrl(step.open);
      return done('Opened in your browser.');
    }
    if (step.background) return await runBackground(step, ctx);

    const startedAt = Date.now();
    const result = await runCommands(step, ctx);
    if (!result.ok) return result;
    if (step.verify === 'setup-status') return await verifySetupStatus(ctx);
    if (step.verify === 'sync') return await verifySync(ctx, startedAt);
    return result;
  } catch (err) {
    return fail(err.message);
  }
}

async function runTools(step, ctx) {
  for (const tool of step.tools) {
    ctx.log(`> ${tool.check}`);
    let verdict = evaluateTool(tool, await ctx.run(tool.check, ctx.parentDir));
    ctx.log(verdict.reason);
    if (verdict.ok) continue;

    ctx.log(`> ${tool.install}`);
    // winget's exit code is not a reliable signal (an already-installed
    // package is a non-zero "success"), so re-checking is what decides.
    await ctx.run(tool.install, ctx.parentDir);
    await ctx.refreshPath();

    ctx.log(`> ${tool.check}`);
    verdict = evaluateTool(tool, await ctx.run(tool.check, ctx.parentDir));
    ctx.log(verdict.reason);
    if (!verdict.ok) {
      return fail(
        `${tool.name} could not be installed. Install it yourself, then run this step again.`
      );
    }
  }
  return done('All the tools are installed.');
}

async function runCommands(step, ctx) {
  let cwd = step.cwd === 'parent' ? ctx.parentDir : ctx.repoDir;
  if (!cwd) return fail('Choose a folder to install into first.');

  for (const command of expandCommands(step, ctx.inputs.surveyIds)) {
    ctx.log(`> ${command}`);

    const cd = CD.exec(command);
    if (cd) {
      cwd = path.resolve(cwd, cd[1].trim().replace(/^"(.*)"$/, '$1'));
      continue;
    }

    const skip = skipReason(command, cwd, ctx);
    if (skip) {
      ctx.log(skip);
      continue;
    }

    const { code } = await ctx.run(command, cwd);
    if (code !== 0) return fail(`This command failed (exit code ${code}): ${command}`);
  }

  if (step.settings) {
    const file = path.join(ctx.repoDir, 'local.settings.json');
    ctx.writeSettings(file, applySettings(ctx.readSettings(file), step.settings, ctx.inputs));
    ctx.log('Saved your settings in local.settings.json (token hidden).');
  }

  return done('Done.');
}

function skipReason(command, cwd, ctx) {
  const clone = GIT_CLONE.exec(command);
  if (clone) {
    const folder = path.basename(clone[1]).replace(/\.git$/i, '');
    if (ctx.exists(path.join(cwd, folder, 'package.json'))) {
      return 'Already downloaded, so this is skipped.';
    }
  }
  if (COPY_SETTINGS.test(command) && ctx.exists(path.join(cwd, 'local.settings.json'))) {
    return 'local.settings.json already exists, so it is kept and only its values are updated.';
  }
  return null;
}

async function runBackground(step, ctx) {
  if (await isReady(step, ctx)) {
    ctx.log(`${step.title}: already running.`);
    return done('Already running.');
  }

  const command = step.commands[0];
  ctx.log(`> ${command}`);
  const proc = ctx.startBackground(step.id, command, ctx.repoDir);

  let exited = false;
  proc.exited.then(() => {
    exited = true;
  });

  const timeoutMs = step.readyTimeoutMs || 180000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) return fail(`${step.title} stopped unexpectedly. The output above says why.`);
    if (await isReady(step, ctx)) return done('Running in the background.');
    await ctx.sleep(1000);
  }
  return fail(`${step.title} did not start within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function isReady(step, ctx) {
  if (step.readyPort) return ctx.isPortOpen(step.readyPort);
  if (step.readyUrl) return (await ctx.fetchJson(step.readyUrl)).status === 200;
  return false;
}

async function verifySetupStatus(ctx) {
  const { status, body } = await ctx.fetchJson(`${CONNECTOR}/api/setup/status`);
  if (status !== 200 || !body) {
    return fail('The connector did not answer. Run "Start the connector" again.');
  }

  const checks = body.checks || {};
  if (!checks.tokenStored || !checks.tokenValid) {
    return fail(
      'SurveyMonkey did not accept your token. Check it in "Create your local settings file", then start the connector again.'
    );
  }
  if (!checks.storageReachable) {
    return fail('The connector cannot reach the storage emulator. Run "Start the storage emulator" again.');
  }

  const who = body.account && body.account.username;
  return done(who ? `Connected to SurveyMonkey as ${who}.` : 'Connected to SurveyMonkey.');
}

async function verifySync(ctx, startedAt) {
  const lines = [];
  for (const id of ctx.inputs.surveyIds) {
    const { body } = await ctx.fetchJson(`${CONNECTOR}/api/surveys/${id}/status`);
    const syncedAt = body && body.last_sync_at ? Date.parse(body.last_sync_at) : NaN;

    // A survey synced on an earlier run still reports synced: true, so only a
    // sync that finished during this step counts.
    if (!body || !body.synced || !(syncedAt >= startedAt - 1000)) {
      return fail(`Survey ${id} did not sync. The output above says why.`);
    }
    lines.push(`Survey ${id}: ${body.response_count} responses synced.`);
  }
  return done(lines.join(' '));
}

module.exports = { runStep, skipReason, CONNECTOR };
