/**
 * surveymonkey.js
 *
 * Lists the surveys a token can see, so people can tick boxes instead of
 * hunting for survey IDs. Same request the connector makes for GET
 * /api/surveys: GET /v3/surveys?per_page=100, following pagination.
 *
 * The token is sent only to api.surveymonkey.com and never logged.
 */

const API = 'https://api.surveymonkey.com/v3';
const MAX_PAGES = 50;

async function listSurveys(token, fetchImpl = fetch) {
  const surveys = [];
  let url = `${API}/surveys?per_page=100`;

  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error('SurveyMonkey did not accept this token. Check that you copied all of it.');
    }
    if (!response.ok) {
      throw new Error(`SurveyMonkey returned an error (${response.status}). Try again in a minute.`);
    }

    const body = await response.json();
    for (const survey of body.data || []) {
      surveys.push({
        id: String(survey.id),
        title: survey.title || `Survey ${survey.id}`,
        responseCount: typeof survey.response_count === 'number' ? survey.response_count : null,
      });
    }

    const next = body.links && body.links.next;
    url = typeof next === 'string' && next.startsWith(`${API}/`) ? next : null;
  }

  return surveys;
}

module.exports = { listSurveys };
