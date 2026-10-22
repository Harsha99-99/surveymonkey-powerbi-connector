const test = require('node:test');
const assert = require('node:assert/strict');

const { inferSkippedQuestionIds } = require('../src/lib/skippedQuestions');
const { buildTables } = require('../src/lib/schema');
const { buildLookups } = require('../src/lib/surveyDetailsCache');
const { flattenResponse } = require('../src/lib/flatten');

const SURVEY_MODIFIED = '2026-01-01T00:00:00Z';

const survey = {
  id: 'S1',
  title: 'Skip test',
  date_modified: SURVEY_MODIFIED,
  pages: [
    {
      id: 'p1',
      questions: [
        {
          id: 'q1',
          family: 'single_choice',
          headings: [{ heading: 'Pick one' }],
          answers: { choices: [{ id: 'c1', text: 'A' }] },
        },
        { id: 'q2', family: 'open_ended', headings: [{ heading: 'Optional comment' }] },
      ],
    },
  ],
};

const order = ['q1', 'q2'];

// Only q1 answered; q2 omitted, as SurveyMonkey does for a skipped question.
const completedSkip = (overrides = {}) => ({
  id: 'r1',
  response_status: 'completed',
  date_created: '2026-02-01T10:00:00Z',
  pages: [{ id: 'p1', questions: [{ id: 'q1', answers: [{ choice_id: 'c1' }] }] }],
  ...overrides,
});

test('a completed response created after the survey changed: absent questions are skipped', () => {
  assert.deepEqual(inferSkippedQuestionIds(completedSkip(), SURVEY_MODIFIED, order), ['q2']);
});

test('a partial response is never inferred to have skipped anything', () => {
  const partial = completedSkip({ response_status: 'partial' });
  assert.deepEqual(inferSkippedQuestionIds(partial, SURVEY_MODIFIED, order), []);
});

test('a response created before the survey last changed is left alone', () => {
  const older = completedSkip({ date_created: '2025-12-01T10:00:00Z' });
  assert.deepEqual(inferSkippedQuestionIds(older, SURVEY_MODIFIED, order), []);
});

test('missing or unparseable dates disable inference rather than guessing', () => {
  assert.deepEqual(inferSkippedQuestionIds(completedSkip({ date_created: null }), SURVEY_MODIFIED, order), []);
  assert.deepEqual(inferSkippedQuestionIds(completedSkip(), null, order), []);
});

test('timestamps without an offset are read as UTC, not local time', () => {
  // SurveyMonkey sends survey date_modified with no offset. Read as local time,
  // this survey change would look hours later than the response and suppress the skip.
  const noOffsetSurvey = '2026-02-01T11:00:00';
  const response = completedSkip({ date_created: '2026-02-01T10:30:00Z' });
  assert.deepEqual(inferSkippedQuestionIds(response, '2026-02-01T10:00:00', order), ['q2']);
  assert.deepEqual(inferSkippedQuestionIds(response, noOffsetSurvey, order), []);
});

test('a fully answered response has nothing to infer', () => {
  const full = completedSkip({
    pages: [
      {
        id: 'p1',
        questions: [
          { id: 'q1', answers: [{ choice_id: 'c1' }] },
          { id: 'q2', answers: [{ text: 'hello' }] },
        ],
      },
    ],
  });
  assert.deepEqual(inferSkippedQuestionIds(full, SURVEY_MODIFIED, order), []);
});

test('sync tables write a skipped row for an inferred skip', () => {
  const tables = buildTables(survey, [completedSkip()], { snapshotDate: '2026-02-02' });
  const row = tables.answers.find((a) => a.response_id === 'r1' && a.question_id === 'q2');

  assert.ok(row, 'the skipped question must produce a row');
  assert.equal(row.is_skipped, true);
  assert.equal(row.value_text, null);
});

test('sync tables write no row for a question missing from a response collected before the survey changed', () => {
  const older = completedSkip({ date_created: '2025-12-01T10:00:00Z' });
  const tables = buildTables(survey, [older], { snapshotDate: '2026-02-02' });

  assert.equal(tables.answers.filter((a) => a.question_id === 'q2').length, 0);
});

test('flat transform writes a skipped row for an inferred skip', () => {
  const lookups = buildLookups(survey);
  const rows = flattenResponse(completedSkip(), lookups.surveyMeta, lookups, '2026-02-02');
  const row = rows.find((r) => r.question_id === 'q2');

  assert.ok(row, 'the skipped question must produce a row');
  assert.equal(row.answer_value, null);
  assert.equal(row.question_text, 'Optional comment');
});
