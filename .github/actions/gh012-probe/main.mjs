import {writeFile} from 'node:fs/promises';
import process from 'node:process';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const runId = Number(process.env.GITHUB_RUN_ID);
const mode = process.env.GH012_MODE;
const token = process.env.GH012_GITHUB_TOKEN;
const foreignArtifactId = Number(process.env.GH012_FOREIGN_ARTIFACT_ID || 0);
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'gh012-controlled-pages-binding-probe'
};

function observation(response) {
  return {
    status: response.status,
    request_id: response.headers.get('x-github-request-id'),
    server_date: response.headers.get('date')
  };
}

async function json(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {message: 'non-json-response'}; }
}

async function api(method, path, body) {
  return fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
}

async function oidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error('OIDC request capability unavailable');
  const response = await fetch(requestUrl, {
    headers: {Authorization: `Bearer ${requestToken}`},
    redirect: 'manual'
  });
  if (response.status !== 200) throw new Error(`OIDC issuance returned ${response.status}`);
  const body = await response.json();
  if (!body.value) throw new Error('OIDC response omitted token');
  return body.value;
}

async function main() {
  if (!repository || !runId || !token || !['control', 'foreign'].includes(mode)) {
    throw new Error('required probe context unavailable');
  }
  const artifactsResponse = await api('GET', `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifactsBody = await json(artifactsResponse);
  if (artifactsResponse.status !== 200) throw new Error(`own artifact inventory returned ${artifactsResponse.status}`);
  const own = (artifactsBody.artifacts || []).find(row => row.name === 'github-pages');
  if (!own) throw new Error('own github-pages artifact missing');
  if (mode === 'foreign' && !foreignArtifactId) throw new Error('foreign artifact ID missing');
  const selectedArtifactId = mode === 'control' ? Number(own.id) : foreignArtifactId;
  let idToken = await oidcToken();
  const createResponse = await api('POST', `/repos/${repository}/pages/deployments`, {
    artifact_id: selectedArtifactId,
    environment: 'github-pages',
    pages_build_version: process.env.GITHUB_SHA,
    oidc_token: idToken
  });
  idToken = '';
  const createBody = await json(createResponse);
  const result = {
    schema: 'gh012-pages-deployment-cell-v1',
    captured_at: new Date().toISOString(),
    mode,
    repository,
    repository_id: Number(process.env.GITHUB_REPOSITORY_ID),
    repository_owner_id: Number(process.env.GITHUB_REPOSITORY_OWNER_ID),
    run_id: runId,
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    environment: 'github-pages',
    own_artifact: {
      id: Number(own.id),
      node_id: own.node_id,
      size_in_bytes: Number(own.size_in_bytes),
      digest: own.digest || null,
      workflow_run_id: Number(own.workflow_run?.id || runId)
    },
    selected_artifact_id: selectedArtifactId,
    selected_is_own: selectedArtifactId === Number(own.id),
    create: {
      ...observation(createResponse),
      deployment_id: createBody.id || null,
      status_url: createBody.status_url || null,
      page_url: createBody.page_url || null,
      message: createBody.message || createBody.error || null,
      error_codes: (createBody.errors || []).map(row => row.code || row.message || null)
    },
    polls: [],
    final_status: createResponse.status === 200 ? 'pending' : 'rejected',
    oidc_token_retained: false,
    github_token_retained: false,
    signed_url_retained: false,
    raw_response_retained: false
  };
  if (createResponse.status === 200 && createBody.id) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, Math.min(5000 + attempt * 500, 15000)));
      const statusResponse = await api('GET', `/repos/${repository}/pages/deployments/${encodeURIComponent(createBody.id)}`);
      const statusBody = await json(statusResponse);
      result.polls.push({...observation(statusResponse), deployment_status: statusBody.status || null});
      if (statusResponse.status !== 200 || ['succeed', 'deployment_failed', 'deployment_content_failed', 'deployment_cancelled', 'deployment_lost'].includes(statusBody.status)) {
        result.final_status = statusBody.status || `http-${statusResponse.status}`;
        break;
      }
    }
  }
  await writeFile('gh012-result.json', `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
  process.stdout.write(`${JSON.stringify({mode, create_status: result.create.status, final_status: result.final_status, selected_is_own: result.selected_is_own})}\n`);
}

main().catch(async error => {
  const failure = {
    schema: 'gh012-pages-deployment-cell-v1',
    captured_at: new Date().toISOString(),
    mode: mode || null,
    harness_error: error.message,
    oidc_token_retained: false,
    github_token_retained: false,
    signed_url_retained: false,
    raw_response_retained: false
  };
  await writeFile('gh012-result.json', `${JSON.stringify(failure, null, 2)}\n`, {mode: 0o600});
  process.stdout.write(`${JSON.stringify({mode: mode || null, harness_error: error.message})}\n`);
  process.exitCode = 0;
});
