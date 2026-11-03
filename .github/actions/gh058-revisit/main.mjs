import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import process from 'node:process';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const repo = process.env.GITHUB_REPOSITORY;
const runId = Number(process.env.GITHUB_RUN_ID);
const testCase = process.env.GH058_CASE;
const suppliedId = process.env.GH058_ARTIFACT_ID || '';
const suppliedDeployment = process.env.GH058_DEPLOYMENT_ID || '';
const foreignSha = process.env.GH058_FOREIGN_SHA || '';
const marker = process.env.GH058_MARKER || '';
const token = process.env.GH058_GITHUB_TOKEN;
const hash = value => createHash('sha256').update(String(value)).digest('hex');

function headers() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'gh058-pages-revisit-action'
  };
}
async function parse(response) {
  const text = await response.text();
  if (!text) return [{}, 0];
  try { return [JSON.parse(text), Buffer.byteLength(text)]; }
  catch { return [{message: 'non-json-response'}, Buffer.byteLength(text)]; }
}
function obs(response, length) {
  const rid = response.headers.get('x-github-request-id');
  return {status: response.status, request_id_sha256: rid ? hash(rid) : null, body_length: length};
}
async function api(method, path, body) {
  return fetch(`${API}${path}`, {method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual'});
}
async function oidc(audience) {
  const base = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base || !requestToken) throw new Error('OIDC request capability unavailable');
  const url = audience ? `${base}&audience=${encodeURIComponent(audience)}` : base;
  const response = await fetch(url, {headers: {Authorization: `Bearer ${requestToken}`}, redirect: 'manual'});
  if (response.status !== 200) throw new Error(`OIDC issuance returned ${response.status}`);
  const body = await response.json();
  if (!body.value) throw new Error('OIDC response omitted token');
  return body.value;
}
async function artifacts() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await api('GET', `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
    const [body] = await parse(response);
    if (response.status === 200) {
      const own = (body.artifacts || []).find(row => row.name === 'github-pages');
      const cross = (body.artifacts || []).find(row => row.name === 'gh058-cross-job');
      if (own && cross) return {own, cross};
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('current-run artifacts unavailable');
}
async function main() {
  if (!repo || !runId || !testCase || !marker || !token) throw new Error('required context unavailable');
  const inventory = await artifacts();
  let selected = Number(inventory.own.id);
  let selectedSource = 'same-job-current-run';
  if (testCase === 'cross_job') { selected = Number(inventory.cross.id); selectedSource = 'other-job-current-run'; }
  if (['stale_same_repo', 'foreign_repo_artifact', 'random_artifact', 'deleted_artifact'].includes(testCase)) {
    selected = Number(suppliedId); selectedSource = testCase;
  }
  let body = {
    artifact_id: testCase === 'string_artifact_id' ? String(inventory.own.id) : selected,
    environment: testCase === 'wrong_environment' ? 'gh058-wrong-environment' : 'github-pages',
    pages_build_version: testCase === 'foreign_build_sha' ? foreignSha : process.env.GITHUB_SHA,
    oidc_token: await oidc(testCase === 'wrong_oidc_audience' ? 'gh058.invalid.audience' : null)
  };
  if (testCase === 'missing_environment') delete body.environment;
  if (testCase === 'missing_build_version') delete body.pages_build_version;
  let route = `/repos/${repo}/pages/deployments`;
  if (testCase === 'encoded_repo_route') route = `/repos/%74est8177/%67h012-pages-a-f1c5eee1/pages/deployments`;
  if (testCase === 'foreign_repo_route') route = '/repos/test8177/gh012-pages-b-f1c5eee1/pages/deployments';
  const response = await api('POST', route, body);
  body.oidc_token = '';
  const [responseBody, responseLength] = await parse(response);
  const result = {
    schema: 'gh058-pages-revisit-cell/v1', case: testCase,
    repository: repo, run_id: runId, run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
    marker_sha256: hash(marker),
    own_artifact: {id: Number(inventory.own.id), workflow_run_id: Number(inventory.own.workflow_run?.id || runId), name: inventory.own.name, digest: inventory.own.digest || null},
    cross_artifact: {id: Number(inventory.cross.id), workflow_run_id: Number(inventory.cross.workflow_run?.id || runId), name: inventory.cross.name, digest: inventory.cross.digest || null},
    selected_artifact_id: selected, selected_source: selectedSource,
    create: {...obs(response, responseLength), deployment_id: responseBody.id || null, page_url: responseBody.page_url || null, message: responseBody.message || responseBody.error || null, error_codes: (responseBody.errors || []).map(row => row.code || row.message || null)},
    polls: [], final_status: response.status === 200 ? 'pending' : 'rejected',
    credential_retained: false, oidc_token_retained: false, raw_request_ids_retained: false
  };
  if (response.status === 200 && responseBody.id) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const poll = await api('GET', `/repos/${repo}/pages/deployments/${encodeURIComponent(responseBody.id)}`);
      const [pollBody, pollLength] = await parse(poll);
      result.polls.push({...obs(poll, pollLength), deployment_status: pollBody.status || null});
      if (poll.status !== 200 || ['succeed','deployment_failed','deployment_content_failed','deployment_cancelled','deployment_lost'].includes(pollBody.status)) {
        result.final_status = pollBody.status || `http-${poll.status}`;
        break;
      }
    }
  }
  await writeFile('gh058-result.json', `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
}
main().catch(async error => {
  await writeFile('gh058-result.json', `${JSON.stringify({schema:'gh058-pages-revisit-cell/v1',case:testCase||null,harness_error:error.message,credential_retained:false,oidc_token_retained:false})}\n`, {mode:0o600});
  process.exitCode = 0;
});
