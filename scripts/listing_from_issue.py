#!/usr/bin/env python3
"""Turn a listing-form issue into a pull request.

Run by the "Listing from issue" workflow when an issue made by the listing
form is opened or edited. The issue body holds the file name in a marker
comment and the listing in a ```yaml block:

    <!-- listing-form: projects/gnss_ir.yml -->
    ...
    ```yaml
    title: ...
    ```

The script checks the listing with check_listings.py, then commits it to a
branch named after the file (gnss_ir) and opens a pull request that closes
the issue. Editing the issue updates that pull request. Problems are posted
as a comment on the issue.

The issue body is untrusted: it's only parsed here, never passed to a shell,
and the file name must match the same pattern as the form's file name field.
"""
import json
import os
import pathlib
import re
import subprocess
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from check_listings import check_file  # noqa: E402

PROJECTS_DIR = "projects"
MARKER = re.compile(r"<!--\s*listing-form:\s*(?:projects/)?(\S+?)\s*-->")
FILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.yml")
FENCE = re.compile(r"(`{3,}|~{3,})[ \t]*ya?ml[ \t]*")
MAX_LISTING = 64 * 1024
BOT = "github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com"


class Rejected(Exception):
    """A problem with the submission, explained to the submitter."""


def run(*args, check=True):
    return subprocess.run(args, cwd=ROOT, check=check, capture_output=True, text=True)


def gh(*args):
    return run("gh", *args).stdout


def parse_body(body):
    """Return (file name, listing text) from the issue body."""
    body = (body or "").replace("\r\n", "\n")
    marker = MARKER.search(body)
    if not marker:
        raise Rejected("The issue doesn't say which file to create. Keep the "
                       "`<!-- listing-form: projects/... -->` line at the top of the issue.")
    name = marker.group(1)
    if not FILE_NAME.fullmatch(name):
        raise Rejected(f"`{name}` isn't a valid file name. Use letters, numbers, hyphens and "
                       "underscores, ending in `.yml`, for example `gnss_reflectometry.yml`.")

    lines = body.split("\n")
    for start, line in enumerate(lines):
        fence = FENCE.fullmatch(line.strip())
        if fence:
            break
    else:
        raise Rejected("The issue doesn't have the listing in a ```` ```yaml ```` code block.")
    char, size = fence.group(1)[0], len(fence.group(1))
    for end in range(start + 1, len(lines)):
        closing = lines[end].strip()
        if closing and set(closing) == {char} and len(closing) >= size:
            break
    else:
        raise Rejected("The ```` ```yaml ```` code block in the issue isn't closed.")
    text = "\n".join(lines[start + 1:end]).strip("\n") + "\n"

    if len(text.encode()) > MAX_LISTING:
        raise Rejected(f"The listing is longer than {MAX_LISTING // 1024} KB.")
    return name, text


def validate(text):
    try:
        metadata = yaml.safe_load(text)
    except yaml.YAMLError as err:
        detail = " ".join(str(err).split())
        raise Rejected(f"The listing isn't valid YAML: {detail}") from None
    if not isinstance(metadata, dict):
        raise Rejected("The listing should be a set of `key: value` lines.")
    missing = [key for key in ("title", "summary", "github") if not metadata.get(key)]
    if missing:
        raise Rejected("The listing is missing " + ", ".join(f"`{key}`" for key in missing) + ".")


def remote_branch_exists(branch):
    return run("git", "ls-remote", "--exit-code", "--heads", "origin", f"refs/heads/{branch}",
               check=False).returncode == 0


def issue_pull_request(number):
    """The open pull request already made for this issue, if any."""
    tag = f"<!-- listing-issue: {number} -->"
    pulls = json.loads(gh("pr", "list", "--state", "open", "--limit", "500",
                          "--json", "number,url,headRefName,body"))
    return next((pull for pull in pulls if tag in (pull.get("body") or "")), None)


def format_problems(problems):
    return "\n".join(f"- **{level.capitalize()}:** {message}" for level, message in problems)


def comment(number, text):
    gh("issue", "comment", str(number), "--body", text)


def submit(issue, base):
    number = issue["number"]
    author = issue["user"]["login"]
    name, text = parse_body(issue.get("body"))
    validate(text)
    branch = name.removesuffix(".yml")
    path = ROOT / PROJECTS_DIR / name

    existing = issue_pull_request(number)
    if existing and existing["headRefName"] != branch:
        raise Rejected(f"This issue already has pull request #{existing['number']} for "
                       f"`{existing['headRefName']}.yml`. Change the file name back, or close "
                       "that pull request and open a new issue.")
    if not existing:
        taken = [p.name for p in (path, path.with_suffix(".yaml")) if p.exists()]
        if taken:
            raise Rejected(f"`{PROJECTS_DIR}/{taken[0]}` already exists. Choose another file name.")
        if remote_branch_exists(branch):
            raise Rejected(f"A branch called `{branch}` already exists. Choose another file name.")

    # Check the links before anything is committed.
    path.write_text(text, encoding="utf-8")
    problems = check_file(path)
    path.unlink()
    errors = [p for p in problems if p[0] == "error"]
    if errors:
        raise Rejected("Some links in the listing are broken:\n\n" + format_problems(problems))

    if existing:
        run("git", "fetch", "--quiet", "origin", branch)
        run("git", "checkout", "--quiet", "-B", branch, "FETCH_HEAD")
    else:
        run("git", "checkout", "--quiet", "-B", branch)
    path.write_text(text, encoding="utf-8")
    run("git", "add", str(path))
    if run("git", "diff", "--cached", "--quiet", check=False).returncode == 0:
        print("The listing hasn't changed; nothing to do.")
        return

    message = (f"{'Update' if existing else 'Add'} {PROJECTS_DIR}/{name}\n\n"
               f"From #{number}.\n\n"
               f"Co-authored-by: {author} <{issue['user']['id']}+{author}@users.noreply.github.com>")
    run("git", "-c", f"user.name={BOT[0]}", "-c", f"user.email={BOT[1]}", "commit", "--quiet", "-m", message)
    run("git", "push", "--quiet", "origin", f"HEAD:refs/heads/{branch}")

    notes = f"\n\nLink check warnings:\n\n{format_problems(problems)}" if problems else ""
    if existing:
        comment(number, f"Updated pull request #{existing['number']} with your changes.{notes}")
        return

    body = (f"Adds `{PROJECTS_DIR}/{name}`, submitted by @{author} with the listing form.\n\n"
            f"Closes #{number}\n\n"
            f"The links were checked when the pull request was opened.{notes}\n\n"
            f"<!-- listing-issue: {number} -->")
    url = gh("pr", "create", "--base", base, "--head", branch,
             "--title", f"Add listing: {name}", "--body", body).strip()
    comment(number, f"Thanks! Opened {url} to add `{PROJECTS_DIR}/{name}`. The library's maintainers "
                    f"have been asked to review it. To make changes, edit this issue.{notes}")


def main():
    event = json.loads(pathlib.Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    issue = event["issue"]
    base = event["repository"]["default_branch"]
    try:
        submit(issue, base)
    except Rejected as err:
        print(f"Rejected: {err}")
        comment(issue["number"], f"{err}\n\nEdit this issue to fix it, and the check runs again.")
    except subprocess.CalledProcessError as err:
        print(f"{' '.join(err.cmd)} failed:\n{err.stderr}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
