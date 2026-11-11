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
as a comment on the issue, and so is anything that goes wrong unexpectedly
(the run then fails, so maintainers see it). Running again for the same
issue picks up where an earlier run stopped: a branch this workflow pushed
for the issue is reused, and the pull request is opened if it's missing.

The issue body is untrusted: it's only parsed here, never passed to a shell,
and the file name must match the same pattern as the form's file name field.
"""
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import traceback

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
BOT_LOGINS = {"app/github-actions", "github-actions[bot]", "github-actions"}  # as gh reports the PR author
LINK_CHECK_SECONDS = 180


class LinkCheckTimeout(BaseException):
    """The link check ran out of time (a server sending its reply very slowly)."""


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


def made_for_issue(branch, number, name, base):
    """True if every commit the branch adds over the default branch is this workflow's for this issue.

    That's the case when an earlier run pushed the branch but couldn't open the
    pull request, or a maintainer closed the pull request and kept the branch.
    Commits inherited from the default branch don't count, and the branch may
    change nothing but this listing's file.
    """
    if branch == base:
        return False
    data = json.loads(gh("api", f"repos/{{owner}}/{{repo}}/compare/{base}...{branch}"))
    commits = data.get("commits") or []
    files = {f["filename"] for f in data.get("files") or []}
    return (data.get("ahead_by", 0) >= 1 and len(commits) == data["ahead_by"]
            and files == {f"{PROJECTS_DIR}/{name}"}
            and all(c["commit"]["author"]["name"] == BOT[0]
                    and f"{PROJECTS_DIR}/{name}\n\nFrom #{number}." in c["commit"]["message"]
                    for c in commits))


def issue_pull_request(number, base):
    """The open pull request this workflow opened for this issue, if any.

    Only pull requests from this repository, opened by the Actions bot against
    the default branch and ending with this issue's tag count: anyone can open a
    pull request from a fork and write the tag in its body.
    """
    tag = f"<!-- listing-issue: {number} -->"
    pulls = json.loads(gh("pr", "list", "--state", "open", "--limit", "500", "--json",
                          "number,url,headRefName,baseRefName,body,author,isCrossRepository"))
    return next((pull for pull in pulls
                 if not pull.get("isCrossRepository") and pull.get("baseRefName") == base
                 and (pull.get("author") or {}).get("login") in BOT_LOGINS
                 and (pull.get("body") or "").rstrip().endswith(tag)), None)


def branch_pull_request(branch, base):
    """An open pull request from this repository's branch, such as one a maintainer opened by hand."""
    pulls = json.loads(gh("pr", "list", "--state", "open", "--head", branch, "--base", base,
                          "--json", "number,url,headRefName,isCrossRepository"))
    return next((pull for pull in pulls if not pull.get("isCrossRepository")), None)


def check_links(path):
    """check_file, but never longer than LINK_CHECK_SECONDS: what's left becomes a warning."""
    def give_up(*_):
        raise LinkCheckTimeout
    previous = signal.signal(signal.SIGALRM, give_up)
    signal.alarm(LINK_CHECK_SECONDS)
    try:
        return check_file(path)
    except LinkCheckTimeout:
        return [("warning", "links: some couldn't be checked in time (a server was very slow)")]
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def format_problems(problems):
    return "\n".join(f"- **{level.capitalize()}:** {message}" for level, message in problems)


def comment(number, text):
    gh("issue", "comment", str(number), "--body", text)


def push(branch, expected_tip):
    """Push HEAD to the branch, only if the branch is still where this run found it.

    expected_tip is the commit the run built on, or "" for a new branch, which
    then must not exist yet: another issue may have taken the name meanwhile.
    """
    ref = f"refs/heads/{branch}"
    try:
        run("git", "push", "--quiet", f"--force-with-lease={ref}:{expected_tip}", "origin", f"HEAD:{ref}")
    except subprocess.CalledProcessError:
        if not expected_tip and remote_branch_exists(branch):
            raise Rejected(f"A branch called `{branch}` already exists. Choose another file name.") from None
        raise


def submit(issue, base):
    number = issue["number"]
    author = issue["user"]["login"]
    name, text = parse_body(issue.get("body"))
    validate(text)
    branch = name.removesuffix(".yml")
    path = ROOT / PROJECTS_DIR / name

    existing = issue_pull_request(number, base)
    if existing and existing["headRefName"] != branch:
        raise Rejected(f"This issue already has pull request #{existing['number']} for "
                       f"`{existing['headRefName']}.yml`, and its file name can't change. Change the "
                       f"file name back, or ask a maintainer to close #{existing['number']} so you can "
                       "use the new name.")
    reuse = existing is not None
    if not existing:
        taken = [p.name for p in (path, path.with_suffix(".yaml")) if p.exists()]
        if taken:
            raise Rejected(f"`{PROJECTS_DIR}/{taken[0]}` already exists. Choose another file name.")
        if remote_branch_exists(branch):
            if not made_for_issue(branch, number, name, base):
                raise Rejected(f"A branch called `{branch}` already exists. Choose another file name.")
            reuse = True
            print(f"Reusing branch {branch}, pushed by an earlier run for #{number}.")

    # Check the links before anything is committed.
    path.write_text(text, encoding="utf-8")
    problems = check_links(path)
    path.unlink()
    if any(level == "error" for level, _ in problems):
        raise Rejected("Some links in the listing are broken:\n\n" + format_problems(problems))

    tip = ""
    if reuse:
        run("git", "fetch", "--quiet", "origin", f"refs/heads/{branch}")
        tip = run("git", "rev-parse", "FETCH_HEAD").stdout.strip()
        run("git", "checkout", "--quiet", "-B", branch, tip)
    else:
        run("git", "checkout", "--quiet", "-B", branch)
    path.write_text(text, encoding="utf-8")
    run("git", "add", str(path))
    changed = run("git", "diff", "--cached", "--quiet", check=False).returncode != 0
    if changed:
        message = (f"{'Update' if reuse else 'Add'} {PROJECTS_DIR}/{name}\n\n"
                   f"From #{number}.\n\n"
                   f"Co-authored-by: {author} <{issue['user']['id']}+{author}@users.noreply.github.com>")
        run("git", "-c", f"user.name={BOT[0]}", "-c", f"user.email={BOT[1]}", "commit", "--quiet", "-m", message)
        push(branch, tip)

    notes = f"\n\nLink check warnings:\n\n{format_problems(problems)}" if problems else ""
    # A pull request a maintainer opened by hand from the branch (say, after gh pr create failed) counts too.
    existing = existing or branch_pull_request(branch, base)
    if existing:
        if changed:
            comment(number, f"Updated pull request #{existing['number']} with your changes.{notes}")
            print(f"Updated pull request #{existing['number']} on branch {branch}.")
        else:
            print("The listing hasn't changed; nothing to do.")
        return

    # No open pull request yet, including when an earlier run pushed the branch but couldn't open one.
    body = (f"Adds `{PROJECTS_DIR}/{name}`, submitted by @{author} with the listing form.\n\n"
            f"Closes #{number}\n\n"
            f"The links were checked when the pull request was opened.{notes}\n\n"
            f"<!-- listing-issue: {number} -->")
    url = gh("pr", "create", "--base", base, "--head", branch,
             "--title", f"Add listing: {name}", "--body", body).strip()
    print(f"Opened {url} from branch {branch}.")
    comment(number, f"Thanks! Opened {url} to add `{PROJECTS_DIR}/{name}`. The library's maintainers "
                    f"have been asked to review it. To make changes, edit this issue.{notes}")


def run_link():
    """This workflow run's URL, when running in GitHub Actions."""
    keys = ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID")
    if not all(os.environ.get(key) for key in keys):
        return None
    server, repository, run_id = (os.environ[key] for key in keys)
    return f"{server}/{repository}/actions/runs/{run_id}"


def main():
    event = json.loads(pathlib.Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    issue = event["issue"]
    base = event["repository"]["default_branch"]
    try:
        # Use the issue as it is now: a re-run of an old run gets the old event.
        issue = json.loads(gh("api", f"repos/{{owner}}/{{repo}}/issues/{issue['number']}"))
        if issue["state"] != "open":
            print(f"Issue #{issue['number']} is closed; nothing to do.")
            return 0
        submit(issue, base)
    except Rejected as err:
        print(f"Rejected: {err}")
        comment(issue["number"], f"{err}\n\nEdit this issue to fix it, and the check runs again.")
    except Exception as err:  # noqa: BLE001 - tell the submitter, and fail the run so maintainers see it
        if isinstance(err, subprocess.CalledProcessError):
            print(f"{' '.join(err.cmd)} failed:\n{err.stderr}", file=sys.stderr)
        traceback.print_exc()
        link = run_link()
        where = f"[the workflow run]({link})" if link else "the workflow run"
        try:
            comment(issue["number"], "Something went wrong while turning this issue into a pull request. "
                                     f"The maintainers can see what happened in {where}. "
                                     "Editing this issue tries again.")
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
