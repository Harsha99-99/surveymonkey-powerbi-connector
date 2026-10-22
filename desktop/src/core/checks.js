/**
 * checks.js
 *
 * Reads tool versions out of command output ("v24.22.0", "4.16.0",
 * "git version 2.55.0.windows.1") and decides whether a tool is good enough.
 */

function parseMajor(output) {
  const match = /(\d+)\.\d+/.exec(String(output || ''));
  return match ? Number(match[1]) : null;
}

/**
 * @param {{name: string, minMajor?: number}} tool
 * @param {{code: number, output: string}} result of running tool.check
 */
function evaluateTool(tool, result) {
  if (!result || result.code !== 0) {
    return { ok: false, reason: `${tool.name} is not installed.` };
  }

  const major = parseMajor(result.output);
  if (tool.minMajor !== undefined && (major === null || major < tool.minMajor)) {
    return {
      ok: false,
      reason: `${tool.name} ${major === null ? 'version unknown' : `version ${major}`} is too old. Version ${tool.minMajor} or later is needed.`,
    };
  }

  return { ok: true, reason: `${tool.name} found (${String(result.output).trim().split(/\r?\n/)[0]}).` };
}

module.exports = { parseMajor, evaluateTool };
