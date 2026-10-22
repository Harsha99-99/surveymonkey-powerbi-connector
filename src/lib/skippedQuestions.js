/**
 * skippedQuestions.js
 *
 * SurveyMonkey leaves a skipped question out of a response's pages entirely,
 * rather than returning it with an empty answers array. This infers which
 * questions a response skipped from the ones it does not contain.
 *
 * The inference applies only where absence reliably means a skip:
 *   - completed responses only. A partial response is missing its unanswered
 *     questions because it was never finished, which is not a skip.
 *   - responses created at or after the survey's last modification. An earlier
 *     response may predate a question added later, and absence cannot tell
 *     those apart from a skip, so those responses are left alone.
 *
 * Pure function, no I/O.
 */

/**
 * @param {object} response           raw SurveyMonkey response
 * @param {string} surveyModifiedAt   survey date_modified (ISO string)
 * @param {string[]} orderedQuestionIds question ids in survey order
 * @returns {string[]} question ids the response skipped, in survey order
 */
/**
 * SurveyMonkey sends some timestamps with no offset (for example the survey's
 * date_modified, "2026-10-22T14:55:00"). Date.parse reads those as local time,
 * which shifts them on any machine not on UTC, so a missing offset is UTC.
 */
function parseUtc(value) {
  if (typeof value !== 'string') return NaN;
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return Date.parse(hasOffset ? value : `${value}Z`);
}

function inferSkippedQuestionIds(response, surveyModifiedAt, orderedQuestionIds) {
  if (response.response_status !== 'completed') return [];

  const created = parseUtc(response.date_created);
  const modified = parseUtc(surveyModifiedAt);
  if (!Number.isFinite(created) || !Number.isFinite(modified)) return [];
  if (created < modified) return [];

  const present = new Set();
  for (const page of response.pages || []) {
    for (const question of page.questions || []) present.add(question.id);
  }

  return orderedQuestionIds.filter((id) => !present.has(id));
}

module.exports = { inferSkippedQuestionIds };
