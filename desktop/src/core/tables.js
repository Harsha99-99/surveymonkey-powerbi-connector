/**
 * tables.js
 *
 * The connector's six tables, as the app presents them. COLUMNS and TYPES
 * mirror TABLE_COLUMNS and TABLE_TYPES in the connector's src/lib/schema.js
 * (the packaged app can't load the connector's code), and
 * test/setupSteps.test.js fails if they ever differ.
 */

const TABLES = [
  { name: 'surveys', label: 'Surveys', description: 'One row per survey: title, question and response counts.' },
  { name: 'questions', label: 'Questions', description: 'One row per question, in survey order.' },
  { name: 'choices', label: 'Choices', description: 'One row per answer option and matrix row, with weights.' },
  { name: 'responses', label: 'Responses', description: 'One row per response: status, dates and time taken.' },
  { name: 'answers', label: 'Answers', description: 'One row per answer. The main table to analyse.' },
  { name: 'flat', label: 'Flat (everything joined)', description: 'Answers with survey and question text included. The easiest single table to start with.' },
];

const NAMES = TABLES.map((t) => t.name);

/** The five tables of the star-schema model in docs/powerbi.md. */
const FULL_MODEL = ['surveys', 'questions', 'choices', 'responses', 'answers'];

const COLUMNS = {
  surveys: [
    'survey_id', 'title', 'language', 'question_count', 'page_count',
    'response_count', 'date_created', 'date_modified', 'snapshot_date',
  ],
  questions: [
    'survey_id', 'question_id', 'page_id', 'page_position', 'position',
    'heading', 'family', 'subtype', 'is_required', 'snapshot_date',
  ],
  choices: [
    'survey_id', 'question_id', 'choice_id', 'col_id', 'text', 'kind',
    'position', 'weight', 'is_na', 'snapshot_date',
  ],
  responses: [
    'survey_id', 'response_id', 'response_status', 'collector_id',
    'date_created', 'date_modified', 'total_time_seconds', 'language',
    'snapshot_date',
  ],
  answers: [
    'survey_id', 'response_id', 'question_id', 'choice_id', 'row_id', 'col_id',
    'row_text', 'value_text', 'value_numeric', 'other_text', 'is_skipped',
    'snapshot_date',
  ],
  flat: [
    'snapshot_date', 'survey_id', 'survey_title', 'response_id',
    'response_status', 'date_created', 'date_modified', 'collector_id',
    'language', 'question_id', 'question_text', 'question_family',
    'question_subtype', 'row_id', 'row_text', 'choice_id', 'value_text',
    'value_numeric', 'other_text', 'is_skipped',
  ],
};

/** Numbers and true/false columns, exactly as the connector declares them. */
const TYPES = {
  surveys: { question_count: 'number', page_count: 'number', response_count: 'number' },
  questions: { page_position: 'number', position: 'number', is_required: 'boolean' },
  choices: { position: 'number', weight: 'number', is_na: 'boolean' },
  responses: { total_time_seconds: 'number' },
  answers: { value_numeric: 'number', is_skipped: 'boolean' },
  flat: { value_numeric: 'number', is_skipped: 'boolean' },
};

/**
 * Date columns. Response dates carry a UTC offset ("2026-10-21T19:30:14+00:00");
 * survey dates don't ("2026-10-21T19:18:00"); snapshot_date is a plain date.
 */
const DATE_TYPES = {
  surveys: { date_created: 'datetime', date_modified: 'datetime', snapshot_date: 'date' },
  questions: { snapshot_date: 'date' },
  choices: { snapshot_date: 'date' },
  responses: { date_created: 'datetimezone', date_modified: 'datetimezone', snapshot_date: 'date' },
  answers: { snapshot_date: 'date' },
  flat: { snapshot_date: 'date', date_created: 'datetimezone', date_modified: 'datetimezone' },
};

/** The relationships from docs/powerbi.md: from a dimension into answers or responses. */
const RELATIONSHIPS = [
  { from: 'questions[question_id]', to: 'answers[question_id]' },
  { from: 'responses[response_id]', to: 'answers[response_id]' },
  { from: 'choices[choice_id]', to: 'answers[choice_id]' },
  { from: 'surveys[survey_id]', to: 'responses[survey_id]' },
];

module.exports = { TABLES, NAMES, FULL_MODEL, COLUMNS, TYPES, DATE_TYPES, RELATIONSHIPS };
