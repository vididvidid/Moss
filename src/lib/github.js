// Script sources: turns GitHub links (files, repos, folders, gists) and plain URLs
// into fetchable files, lists the scripts in a repo, and fetches with an optional token.
const GITHUB_HOSTS = ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com'];

/** → { type: 'file', url, label } or { type: 'repo', owner, repo, ref, dir } */
export function parseSourceUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) links can be imported.');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (url.hostname === 'github.com') {
    const [owner, rawRepo, kind, ref, ...rest] = parts;
    if (!owner || !rawRepo) throw new Error('Link to a GitHub repository, folder or file.');
    const repo = rawRepo.replace(/\.git$/, '');
    if ((kind === 'blob' || kind === 'raw') && ref && rest.length) {
      return { type: 'file', url: rawUrl(owner, repo, ref, rest.join('/')), label: `${owner}/${repo}/${rest.join('/')}` };
    }
    if (!kind || kind === 'tree') return { type: 'repo', owner, repo, ref: ref || 'HEAD', dir: rest.join('/') };
    throw new Error(`Moss can't import GitHub "${kind}" pages — link to a file, folder or repository.`);
  }
  if (url.hostname === 'gist.github.com') {
    const [user, id, raw] = parts;
    if (!user || !id) throw new Error('Link to a gist, e.g. https://gist.github.com/user/1234abcd');
    // /raw without a file name serves the gist's first file at its latest revision.
    return { type: 'file', url: raw === 'raw' ? url.href : `https://gist.githubusercontent.com/${user}/${id}/raw`, label: `gist ${user}/${id}` };
  }
  return { type: 'file', url: url.href, label: url.hostname + url.pathname };
}

export function rawUrl(owner, repo, ref, path) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function authHeaders(url, token) {
  return token && GITHUB_HOSTS.includes(new URL(url).hostname) ? { Authorization: `Bearer ${token}` } : {};
}

/** bust: add a throwaway query so caches (GitHub's raw CDN keeps files ~5 min) are skipped. */
export async function fetchText(url, { token, bust = false, fetchImpl = fetch } = {}) {
  const target = new URL(url);
  if (bust) target.searchParams.set('moss', Date.now());
  let res;
  try {
    res = await fetchImpl(target.href, { cache: 'no-store', headers: authHeaders(url, token) });
  } catch (e) {
    throw new Error(`Couldn't reach ${target.hostname} (${e.message}).`);
  }
  if (res.status === 404) throw new Error(`Not found (404) at ${target.hostname}. If the repo is private, add a GitHub token in Settings.`);
  if (!res.ok) throw new Error(`${target.hostname} answered HTTP ${res.status}.`);
  return res.text();
}

/** All .js files of a repo (under `dir`), each with the raw URL Moss will track. */
export async function listRepoScripts({ owner, repo, ref, dir }, { token, fetchImpl = fetch } = {}) {
  const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const res = await fetchImpl(api, { headers: { Accept: 'application/vnd.github+json', ...authHeaders(api, token) } });
  if (res.status === 404) throw new Error(`Repository ${owner}/${repo} not found. If it's private, add a GitHub token in Settings.`);
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached. Try again later, or add a GitHub token in Settings.');
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`);
  const { tree = [] } = await res.json();
  const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
  return tree
    .filter((e) => e.type === 'blob' && e.path.endsWith('.js') && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path, url: rawUrl(owner, repo, ref, e.path) }));
}
