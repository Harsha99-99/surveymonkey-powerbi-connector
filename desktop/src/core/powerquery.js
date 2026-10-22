/**
 * powerquery.js
 *
 * Builds the URL and the Power Query (M) for one table, in CSV or JSON, for
 * the latest data or a dated snapshot.
 *
 * Each query is self-contained, so people paste one per table into a Blank
 * query without first creating a helper function. Two rules from
 * docs/powerbi.md are kept:
 *   - The base URL is a constant and the rest goes in RelativePath and Query.
 *     The Power BI service refuses to refresh URLs built by string joining.
 *   - Column types are set explicitly, because a pasted query gets no automatic
 *     "Changed Type" step and every CSV column would otherwise arrive as text.
 */

const { NAMES, COLUMNS, TYPES, DATE_TYPES } = require('./tables');

const LOCAL_CONNECTOR = 'http://localhost:7071';
const SURVEY_ID = /^\d{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const M_TYPE = {
  number: 'type number',
  boolean: 'type logical',
  date: 'type date',
  datetime: 'type datetime',
  datetimezone: 'type datetimezone',
};

function check({ baseUrl, surveyId, table, format, snapshot }) {
  if (!/^https?:\/\/[^\s"]+$/.test(baseUrl)) throw new Error(`Not a connector address: ${baseUrl}`);
  if (!SURVEY_ID.test(String(surveyId))) throw new Error(`Not a survey ID: ${surveyId}`);
  if (!NAMES.includes(table)) throw new Error(`Not a table: ${table}`);
  if (format !== 'csv' && format !== 'json') throw new Error('Format must be csv or json.');
  if (snapshot && !DATE.test(snapshot)) throw new Error('A snapshot must look like 2026-10-22.');
}

function normalize(options) {
  const opts = { baseUrl: LOCAL_CONNECTOR, format: 'csv', snapshot: null, ...options };
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  check(opts);
  return opts;
}

function tableUrl(options) {
  const { baseUrl, surveyId, table, format, snapshot } = normalize(options);
  const url = new URL(`${baseUrl}/api/surveys/${surveyId}/data/${table}`);
  if (format === 'json') url.searchParams.set('format', 'json');
  if (snapshot) url.searchParams.set('snapshot', snapshot);
  return url.toString();
}

/** [column, M type] pairs for a table, in column order. */
function columnTypes(table) {
  const declared = { ...TYPES[table], ...DATE_TYPES[table] };
  return COLUMNS[table].filter((c) => declared[c]).map((c) => [c, M_TYPE[declared[c]]]);
}

function buildQuery(options) {
  const { baseUrl, surveyId, table, format, snapshot } = normalize(options);

  const query = [];
  if (format === 'json') query.push('format = "json"');
  if (snapshot) query.push(`snapshot = "${snapshot}"`);

  const request = [`RelativePath = "api/surveys/${surveyId}/data/${table}"`];
  if (query.length > 0) request.push(`Query = [${query.join(', ')}]`);

  // For JSON, the column list makes an empty table still have its columns,
  // which the type step below needs.
  const columnList = `{${COLUMNS[table].map((c) => `"${c}"`).join(', ')}}`;
  const parse =
    format === 'json'
      ? [
          '    Parsed = Json.Document(Response),',
          `    Rows = Table.FromRecords(Parsed[data], ${columnList}, MissingField.UseNull),`,
        ]
      : [
          '    Parsed = Csv.Document(Response, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),',
          '    Rows = Table.PromoteHeaders(Parsed, [PromoteAllScalars = true]),',
        ];

  const types = columnTypes(table).map(([column, type]) => `{"${column}", ${type}}`);
  const source = snapshot ? `snapshot ${snapshot}` : 'latest sync';

  return [
    `// ${table} for survey ${surveyId} (${source}, ${format.toUpperCase()}), from the SurveyMonkey to Power BI connector.`,
    'let',
    `    Response = Web.Contents("${baseUrl}", [${request.join(', ')}]),`,
    ...parse,
    `    Typed = Table.TransformColumnTypes(Rows, {${types.join(', ')}}, "en-US")`,
    'in',
    '    Typed',
  ].join('\n');
}

module.exports = { LOCAL_CONNECTOR, tableUrl, buildQuery, columnTypes };
