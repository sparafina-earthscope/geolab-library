#!/usr/bin/env python3
"""Check the links in project listing files.

    python scripts/check_listings.py                         # every file in projects/
    python scripts/check_listings.py projects/birthquake.yml # just these files

For each listing it checks that:
  - the file is valid YAML
  - `github` is a public repository (and, for a /tree/ URL, that the folder exists)
  - `nbgitpuller` opens GeoLab, and the repository, branch and notebook it
    points to exist
  - `thumbnail` loads as an image, resolved the same way the gallery does
  - `image_tag` (and `recommended_image`, when it names a registry image) is a
    public image whose tag exists

Broken links are errors. A link that can't be checked right now (a timeout, a
GitHub rate limit) is a warning, so a flaky network doesn't fail the check.
Exits 1 if any file has an error.

Set GITHUB_TOKEN to raise GitHub's API rate limit; the workflow does this.
In GitHub Actions, problems are also shown as annotations on the pull request.
"""
import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from library_listing import thumbnail_url  # noqa: E402  (same thumbnail rules as the gallery)

USER_AGENT = "geolab-library-link-check (+https://github.com/EarthScope/geolab-library)"
TIMEOUT = 20
GEOLAB_HOST = "geolab.earthscope.cloud"
MANIFEST_TYPES = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


class Unreachable(Exception):
    """The server couldn't be reached, or kept failing: we can't tell if the link works."""


# ── HTTP ────────────────────────────────────────────────────────────────

def http(url, method="GET", headers=None, read=False, tries=3):
    """Return (status, headers, body). Retries timeouts and 5xx; raises Unreachable."""
    request = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT, **(headers or {})})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return response.status, response.headers, response.read() if read else b""
        except urllib.error.HTTPError as err:
            if err.code < 500 or attempt == tries - 1:
                return err.code, err.headers, b""
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            if attempt == tries - 1:
                raise Unreachable(f"couldn't connect ({getattr(err, 'reason', err)})") from err
        time.sleep(2 * (attempt + 1))
    raise Unreachable("the server kept returning errors")


def github_api(path):
    """GET an api.github.com path: the JSON, or None for a 404."""
    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    status, _, body = http(f"https://api.github.com{path}", headers=headers, read=True)
    if status == 404:
        return None
    if status in (403, 429):
        raise Unreachable("GitHub's API rate limit was reached")
    if status != 200:
        raise Unreachable(f"GitHub's API returned {status}")
    return json.loads(body)


# ── GitHub repositories and paths ───────────────────────────────────────

GITHUB_URL = re.compile(
    r"^https?://(?:www\.)?github\.com/([^/?#]+)/([^/?#]+?)(?:\.git)?"
    r"(?:/(?:tree|blob)/([^/?#]+)(/[^?#]*)?)?/?(?:[?#].*)?$",
    re.IGNORECASE,
)


def parse_github(url):
    """(owner, repo, ref, path) for a github.com URL, or None for other hosts."""
    match = GITHUB_URL.match(url or "")
    if not match:
        return None
    owner, repo, ref, path = match.groups()
    return owner, repo, ref or "", (path or "").strip("/")


def quote(text):
    return urllib.parse.quote(text, safe="")


def get_repo(owner, repo):
    info = github_api(f"/repos/{quote(owner)}/{quote(repo)}")
    if info is None or info.get("private"):
        return None
    return info


def path_exists(owner, repo, ref, path):
    query = f"?ref={quote(ref)}" if ref else ""
    return github_api(f"/repos/{quote(owner)}/{quote(repo)}/contents/{urllib.parse.quote(path)}{query}") is not None


def repo_missing(owner, repo):
    return f"repository {owner}/{repo} wasn't found on GitHub, or isn't public"


# ── Checks: each returns a list of (level, message) ─────────────────────

def check_github(url):
    gh = parse_github(url)
    if gh is None:
        status, _, _ = http(url)
        return [] if status < 400 else [("error", f"github: {url} returned HTTP {status}")]
    owner, repo, ref, path = gh
    info = get_repo(owner, repo)
    if info is None:
        return [("error", f"github: {repo_missing(owner, repo)}")]
    if path and not path_exists(owner, repo, ref, path):
        return [("error", f"github: {path} isn't on the {ref} branch of {info['full_name']}")]
    return []


def notebook_path(urlpath):
    """The file or folder an nbgitpuller urlpath opens, relative to the repository."""
    parts = [part for part in urlpath.split("?")[0].split("#")[0].split("/") if part]
    for index, part in enumerate(parts):
        if part in ("tree", "render", "notebooks", "edit"):
            # The part after the marker is the folder the repository is cloned into.
            return "/".join(urllib.parse.unquote(p) for p in parts[index + 2:])
    return ""


def check_nbgitpuller(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname != GEOLAB_HOST:
        return [("error", f"nbgitpuller: the link should open GeoLab (https://{GEOLAB_HOST}/), not {parsed.hostname}")]
    query = urllib.parse.parse_qs(parsed.query)
    repo_url = query.get("repo", [""])[0]
    if not repo_url:
        return []  # a launch permalink, with no repository to check
    branch = query.get("branch", [""])[0]
    path = notebook_path(query.get("urlpath", [""])[0])

    gh = parse_github(repo_url)
    if gh is None:
        status, _, _ = http(repo_url)
        return [] if status < 400 else [("error", f"nbgitpuller: the repository {repo_url} returned HTTP {status}")]
    owner, repo, _, _ = gh
    info = get_repo(owner, repo)
    if info is None:
        return [("error", f"nbgitpuller: {repo_missing(owner, repo)} (from the repo= part of the link)")]
    where = f"the {branch} branch" if branch else "the default branch"
    if path:
        if not path_exists(owner, repo, branch, path):
            return [("error", f"nbgitpuller: {path} isn't on {where} of {info['full_name']} "
                              "(check the urlpath= and branch= parts of the link)")]
    elif branch and github_api(f"/repos/{quote(owner)}/{quote(repo)}/branches/{quote(branch)}") is None:
        return [("error", f"nbgitpuller: {info['full_name']} has no branch called {branch}")]
    return []


def check_thumbnail(metadata):
    thumbnail = str(metadata.get("thumbnail") or "").strip()
    url = thumbnail_url({**metadata, "thumbnail": thumbnail})
    if url is None:
        return [("error", "thumbnail: a path inside the repository only works when `github` is the "
                          "repository's main page (https://github.com/org/repo); use the image's full URL instead")]
    status, headers, _ = http(url)
    if status >= 400:
        return [("error", f"thumbnail: {url} returned HTTP {status}")]
    content_type = headers.get("Content-Type", "")
    if not content_type.startswith("image/"):
        hint = " (add ?raw=true to a GitHub image URL)" if "github.com" in url and "/blob/" in url else ""
        return [("error", f"thumbnail: {url} isn't an image (it's {content_type or 'an unknown type'}){hint}")]
    return []


def parse_image(reference):
    """(registry, repository, tag_or_digest, tag) for an image reference like ghcr.io/org/img:1.0."""
    name, _, digest = reference.partition("@")
    tag = ""
    if ":" in name.rsplit("/", 1)[-1]:
        name, tag = name.rsplit(":", 1)
    parts = name.split("/")
    if len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost"):
        registry, repository = parts[0], "/".join(parts[1:])
    else:
        registry, repository = "docker.io", name
    if registry in ("docker.io", "index.docker.io"):
        registry = "registry-1.docker.io"
        if "/" not in repository:
            repository = f"library/{repository}"
    return registry, repository, digest or tag or "latest", tag


def registry_token(challenge, repository):
    """An anonymous pull token from a registry's `WWW-Authenticate: Bearer ...` challenge, or None."""
    if not challenge.lower().startswith("bearer "):
        return None
    params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    if "realm" not in params:
        return None
    query = {"service": params.get("service", ""), "scope": params.get("scope") or f"repository:{repository}:pull"}
    status, _, body = http(f"{params['realm']}?{urllib.parse.urlencode(query)}", read=True)
    if status != 200:
        return None
    data = json.loads(body)
    return data.get("token") or data.get("access_token")


def check_image(key, reference):
    registry, repository, ref, tag = parse_image(reference)
    url = f"https://{registry}/v2/{repository}/manifests/{ref}"
    headers = {"Accept": MANIFEST_TYPES}
    status, response_headers, _ = http(url, method="HEAD", headers=headers)
    if status == 401:
        token = registry_token(response_headers.get("WWW-Authenticate", ""), repository)
        if token:
            status, _, _ = http(url, method="HEAD", headers={**headers, "Authorization": f"Bearer {token}"})
    problems = []
    if status in (401, 403):
        problems.append(("error", f"{key}: {reference} wasn't found, or needs a login to pull. "
                                  "The image must be in a public registry"))
    elif status == 404:
        problems.append(("error", f"{key}: {reference} wasn't found in {registry}"))
    elif status >= 400:
        raise Unreachable(f"the registry returned HTTP {status}")
    if not tag and "@" not in reference:
        problems.append(("warning", f"{key}: {reference} has no tag, so it means `latest`. "
                                    "Use a version tag so the listing always opens the same image"))
    return problems


def looks_like_image(value):
    """Names like `geolab_base` are GeoLab's own images, not registry references."""
    return "/" in value or ":" in value


# ── Running the checks ──────────────────────────────────────────────────

def check_file(path):
    try:
        metadata = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as err:  # noqa: BLE001 - any parse failure is reported
        detail = " ".join(str(err).split())  # PyYAML errors span several lines
        return [("error", f"isn't valid YAML: {detail}")]
    if not isinstance(metadata, dict):
        return [("error", "should be a set of `key: value` lines")]

    checks = []
    if metadata.get("github"):
        checks.append(("github", lambda: check_github(str(metadata["github"]).strip())))
    if metadata.get("nbgitpuller"):
        checks.append(("nbgitpuller", lambda: check_nbgitpuller(str(metadata["nbgitpuller"]).strip())))
    if metadata.get("thumbnail"):
        checks.append(("thumbnail", lambda: check_thumbnail(metadata)))
    for key in ("image_tag", "recommended_image"):
        value = str(metadata.get(key) or "").strip()
        if value and looks_like_image(value):
            checks.append((key, lambda key=key, value=value: check_image(key, value)))

    problems = []
    for key, check in checks:
        try:
            problems.extend(check())
        except Unreachable as err:
            problems.append(("warning", f"{key}: couldn't be checked: {err}"))
    return problems


def report(path, problems):
    in_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    for level, message in problems:
        if in_actions:
            # Workflow commands need %, CR and LF escaped, and commas escaped in properties.
            text = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            file = str(path).replace("%", "%25").replace(",", "%2C")
            print(f"::{level} file={file},title=Listing check::{text}")
        else:
            print(f"{path}: {level}: {message}")


def write_summary(results):
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary:
        return
    lines = ["## Listing link check", "", "| File | Result |", "|---|---|"]
    for path, problems in results:
        if not problems:
            lines.append(f"| `{path}` | ✅ All links work |")
        for level, message in problems:
            icon = "❌" if level == "error" else "⚠️"
            cell = message.replace("|", r"\|")
            lines.append(f"| `{path}` | {icon} {cell} |")
    with open(summary, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", type=pathlib.Path, help="listing files (default: all of projects/)")
    args = parser.parse_args()
    files = args.files or sorted((ROOT / "projects").glob("*.y*ml"))

    results = []
    for path in files:
        try:
            shown = path.resolve().relative_to(ROOT)
        except ValueError:
            shown = path
        problems = check_file(path)
        report(shown, problems)
        if not problems:
            print(f"{shown}: ok")
        results.append((shown, problems))
    write_summary(results)

    errors = sum(level == "error" for _, problems in results for level, _ in problems)
    warnings = sum(level == "warning" for _, problems in results for level, _ in problems)
    print(f"\nChecked {len(files)} file(s): {errors} error(s), {warnings} warning(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
