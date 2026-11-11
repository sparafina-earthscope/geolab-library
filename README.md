# GeoLab Library

Source for the EarthScope Community Library at
[docs.earthscope.org/geolab/library](https://docs.earthscope.org/geolab/library): a
searchable gallery of notebooks and images that run in GeoLab.

Each project listing is one YAML file of metadata in [`projects/`](projects/). The site is built
with [MyST](https://mystmd.org) and deployed by Netlify.

## Add a project

Copy [`template.yml`](template.yml) into `projects/`, fill it in, and open a
pull request. See https://docs.earthscope.org/geolab/library/contributing for contributor instructions.

Or fill in the [listing form](listing-form/). It opens a GitHub issue with the
listing in it. When the issue is created, the
[Listing from issue](.github/workflows/listing-from-issue.yml) workflow
([`scripts/listing_from_issue.py`](scripts/listing_from_issue.py)) checks the
links, commits the file to a branch named after it (`gnss_ir.yml` goes on
branch `gnss_ir`), opens a pull request that closes the issue, and posts the
link in the issue. If something's wrong, it says so in an issue comment
instead, and a run that fails unexpectedly also comments and links to its
log. Editing the issue updates the pull request, or runs everything again
if no pull request was opened. It won't overwrite an existing listing, or a
branch it didn't make for that issue.

To turn down a submission, close the issue. Closing only the pull request
lets the contributor's next edit open a new one.

The people in [`.github/CODEOWNERS`](.github/CODEOWNERS) are asked to review,
and notified of, every pull request that changes `projects/`.

The workflow needs **Settings → Actions → General → Allow GitHub Actions to
create and approve pull requests** turned on. It runs the link check itself,
before committing. On the pull requests it opens, GitHub holds the
[Check listings](.github/workflows/check-listings.yml) run until a maintainer
approves it (**Approve and run** on the pull request).

| Field | Used for |
|-------|----------|
| `title` | Card title |
| `author` | Author names (clickable filter) |
| `summary` | Card description (searched) |
| `tags` | Tag chips (clickable filters) |
| `thumbnail` | Card image: a full URL, or a path in the `github` repo |
| `nbgitpuller` | Where the card and "Open in GeoLab" link to |
| `github` | "Source" link, and base for a relative `thumbnail` |

The remaining template fields (`recommended_image`, `citation`, …) are customizable and appear in the long-form description pop-out.

## Run locally

Needs Node (for MyST) and Python 3. The only Python dependency is PyYAML,
pinned to 6.x in [`requirements.txt`](requirements.txt). It's used by the
build plugin and both scripts; Netlify installs it automatically. Install
it into the `python3` on your PATH, since MyST runs `library_listing.py`
with that interpreter.

```bash
pip install -r requirements.txt
npx mystmd@~1.10.1 start        # http://localhost:3000/project-tiles
```

`~1.10.1` matches what Netlify installs (see
[`build-docs.sh`](https://github.com/EarthScope/docs.earthscope.org/blob/main/scripts/build-docs.sh)).
Restart `myst start` after adding or editing files in `projects/`.

`npx mystmd@~1.10.1 build --html` writes a static site to `_build/html/`.

## Test with many projects

[`scripts/make_dummy_projects.py`](scripts/make_dummy_projects.py) writes fake
projects, plus copies of the real ones, to `.dummy-projects/` (git-ignored).
Point the build at that folder with `GEOLAB_PROJECTS_DIR`:

```bash
python scripts/make_dummy_projects.py --count 1000
GEOLAB_PROJECTS_DIR=.dummy-projects npx mystmd@~1.10.1 start
```

Options: `--count N` (default 1000), `--seed N` (same seed, same data),
`--out DIR`. Re-running replaces the folder.

About 70% of dummy projects get a real image from picsum.photos (to see lazy
loading), 20% none, and 10% a broken URL (to see the fallback letter).

## Audit tags

[`scripts/audit_tags.py`](scripts/audit_tags.py) lists every tag with its
count and the files using it, and suggests merges. Run it when reviewing a
new project PR:

```bash
python scripts/audit_tags.py                  # tags in projects/
python scripts/audit_tags.py --field author   # same checks for author names
```

It reports:

- **Variants**: tags that differ only in case, spaces, `-` or `_`
  (`earthscope_sdk` / `EarthScope SDK`).
- **Plurals**: `earthquake` / `earthquakes`.
- **Similar**: likely typos (`seismolgy` / `seismology`). These are fuzzy
  matches, so check them first. `--cutoff` (default 0.85) sets how close two
  tags must be.
- **Used once**: tags on a single project that weren't flagged above. They
  may be too specific.

For each group it suggests the most-used spelling and says "tie: pick one"
when the counts are equal. It never edits files: fix the tags in the project
YAML by hand. It does not match initials against full names (`S. Parafina` /
`Sophia Parafina`).

## Check links

[`scripts/check_listings.py`](scripts/check_listings.py) checks the links in
listing files. The [Check listings](.github/workflows/check-listings.yml)
workflow runs it on every pull request that adds or changes a file in
`projects/`, and fails the check if a link is broken:

```bash
python scripts/check_listings.py                          # every file in projects/
python scripts/check_listings.py projects/birthquake.yml  # just this file
```

It checks that:

- the file is valid YAML
- `github` is a public repository, and a `/tree/<branch>/<folder>` URL points
  to a folder that exists
- `nbgitpuller` opens GeoLab, and its repository, branch and notebook exist
- `thumbnail` loads as an image, found the same way the gallery finds it
- `image_tag`, and `recommended_image` when it names a registry image, is a
  public image in its registry (Docker Hub, GHCR, public ECR and others) with
  that tag

A link that can't be checked at the moment, because of a timeout or GitHub's
rate limit, is a warning rather than an error. Set `GITHUB_TOKEN` (for
example, `GITHUB_TOKEN=$(gh auth token)`) to raise the GitHub rate limit when
running it locally.

The [listing form](listing-form/) runs the repository, notebook and thumbnail
checks in the browser as contributors fill it in, as warnings only.

## How it works

```
projects/*.yml ──► library_listing.py ──► {geolab-library} widget ──► browser
                   (MyST transform:        (plugins/geolab-library.mjs:
                    YAML → item list)       search, filters, paging)
```

1. [`project_tiles.md`](project_tiles.md) contains a `{geolab-library}`
   directive. The directive, defined in
   [`plugins/geolab-library.mjs`](plugins/geolab-library.mjs), outputs an
   empty [anywidget](https://mystmd.org/guide/widgets) node.
2. [`library_listing.py`](library_listing.py) is a MyST executable plugin.
   At build time it reads every project YAML file and puts the list into
   that widget's `model.items`.
3. In the browser, the `render` function in `geolab-library.mjs` draws the
   gallery from that list:
   - ranked text search over title, summary, authors and tags
   - tag and author filters (click any chip or author name)
   - 24 cards at a time with "Show more"; only those cards are in the DOM
   - thumbnails with `loading="lazy"`, and a letter placeholder if missing
   - filter state in the URL (`?q=…&tag=…&author=…`) for sharing links
   - light/dark colors that follow the site theme

Both plugins are in this repo, so the build has no plugin downloads.

The whole project list is embedded in the page: about 460 KB (42 KB
gzipped) for 1000 projects. That's fine up to several thousand. Beyond that,
move the list into a separate JSON file the widget fetches. MyST only copies
a widget's `esm` and `css` files into the site, so that would need its own
build step.
