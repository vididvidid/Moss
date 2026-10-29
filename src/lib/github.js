'use strict';
/*
 * Script sources: turns GitHub links (files, repos, folders, gists) and plain URLs
 * into fetchable files, lists the scripts in a repo, and fetches with an optional token.
 *
 * struct source_link {
 *     type: 'file' | 'repo';
 *     url, label: string;              // type 'file'
 *     owner, repo, ref, dir: string;   // type 'repo'
 * }
 */
const GITHUB_HOSTS = ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com'];

/*
 * path_parts(url) -> the decoded, non-empty segments of url's path
 */
function path_parts(url) {
    const out = [];
    for (const part of url.pathname.split('/')) {
        if (part !== '') {
            out.push(decodeURIComponent(part));
        }
    }
    return out;
}

/*
 * parse_source_url(input) -> struct source_link (throws on links Moss can't use)
 */
export function parse_source_url(input) {
    let url;
    try {
        url = new URL(String(input).trim());
    } catch (e) {
        throw new Error('That is not a valid URL.');
    }
    if (!/^https?:$/.test(url.protocol)) {
        throw new Error('Only http(s) links can be imported.');
    }
    const parts = path_parts(url);

    if (url.hostname === 'github.com') {
        const owner = parts[0];
        const raw_repo = parts[1];
        const kind = parts[2];
        const ref = parts[3];
        const rest = parts.slice(4);
        if (!owner || !raw_repo) {
            throw new Error('Link to a GitHub repository, folder or file.');
        }
        const repo = raw_repo.replace(/\.git$/, '');
        if ((kind === 'blob' || kind === 'raw') && ref && rest.length > 0) {
            return { type: 'file', url: raw_url(owner, repo, ref, rest.join('/')), label: `${owner}/${repo}/${rest.join('/')}` };
        }
        if (!kind || kind === 'tree') {
            return { type: 'repo', owner: owner, repo: repo, ref: ref || 'HEAD', dir: rest.join('/') };
        }
        throw new Error(`Moss can't import GitHub "${kind}" pages — link to a file, folder or repository.`);
    }
    if (url.hostname === 'gist.github.com') {
        const user = parts[0];
        const id = parts[1];
        if (!user || !id) {
            throw new Error('Link to a gist, e.g. https://gist.github.com/user/1234abcd');
        }
        // /raw without a file name serves the gist's first file at its latest revision.
        const file_url = parts[2] === 'raw' ? url.href : `https://gist.githubusercontent.com/${user}/${id}/raw`;
        return { type: 'file', url: file_url, label: `gist ${user}/${id}` };
    }
    return { type: 'file', url: url.href, label: url.hostname + url.pathname };
}

/*
 * raw_url(owner, repo, ref, path) -> raw.githubusercontent.com URL of one file
 */
export function raw_url(owner, repo, ref, path) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
        parts[i] = encodeURIComponent(parts[i]);
    }
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${parts.join('/')}`;
}

/*
 * auth_headers(url, token) -> an Authorization header, but only for GitHub hosts
 */
function auth_headers(url, token) {
    if (!token || !GITHUB_HOSTS.includes(new URL(url).hostname)) {
        return {};
    }
    return { Authorization: `Bearer ${token}` };
}

/*
 * fetch_text(url, opts) -> the file's text
 *   opts.token: GitHub token; opts.bust: add a throwaway query so caches (GitHub's
 *   raw CDN keeps files ~5 min) are skipped; opts.fetch_impl: fetch replacement for tests.
 */
export async function fetch_text(url, opts) {
    const options = opts || {};
    const fetch_impl = options.fetch_impl || fetch;
    const target = new URL(url);
    if (options.bust) {
        target.searchParams.set('moss', Date.now());
    }
    let res;
    try {
        res = await fetch_impl(target.href, { cache: 'no-store', headers: auth_headers(url, options.token) });
    } catch (e) {
        throw new Error(`Couldn't reach ${target.hostname} (${e.message}).`);
    }
    if (res.status === 404) {
        throw new Error(`Not found (404) at ${target.hostname}. If the repo is private, add a GitHub token in Settings.`);
    }
    if (!res.ok) {
        throw new Error(`${target.hostname} answered HTTP ${res.status}.`);
    }
    return res.text();
}

/*
 * list_repo_scripts(link, opts) -> [{ path, url }] for every .js / .moss file of a repo (under link.dir)
 */
export async function list_repo_scripts(link, opts) {
    const options = opts || {};
    const fetch_impl = options.fetch_impl || fetch;
    const api = `https://api.github.com/repos/${link.owner}/${link.repo}/git/trees/${encodeURIComponent(link.ref)}?recursive=1`;
    const headers = Object.assign({ Accept: 'application/vnd.github+json' }, auth_headers(api, options.token));
    const res = await fetch_impl(api, { headers: headers });
    if (res.status === 404) {
        throw new Error(`Repository ${link.owner}/${link.repo} not found. If it's private, add a GitHub token in Settings.`);
    }
    if (res.status === 403 || res.status === 429) {
        throw new Error('GitHub rate limit reached. Try again later, or add a GitHub token in Settings.');
    }
    if (!res.ok) {
        throw new Error(`GitHub answered HTTP ${res.status}.`);
    }
    const body = await res.json();
    const tree = body.tree || [];
    const prefix = link.dir ? `${link.dir.replace(/\/$/, '')}/` : '';
    const out = [];
    for (const entry of tree) {
        if (entry.type === 'blob' && /\.(js|moss)$/.test(entry.path) && entry.path.startsWith(prefix)) {
            out.push({ path: entry.path, url: raw_url(link.owner, link.repo, link.ref, entry.path) });
        }
    }
    return out;
}
