// GeoLab Library listing form: builds a project listing YAML file from the form.
// Field order and keys follow template.yml in the geolab-library repository.

// TESTING ONLY: pull requests go to the sparafina-earthscope fork. Change back to
// 'EarthScope/geolab-library' and 'main' before merging into EarthScope.
const REPO = 'sparafina-earthscope/geolab-library';
const BRANCH = 'submit-form';
const PROJECTS_DIR = 'projects';
// GitHub rejects very long URLs; past this, the file is pasted in by hand.
const MAX_GITHUB_URL = 8000;

// ── YAML output ────────────────────────────────────────────────────────

// Plain words YAML would read as booleans, null, numbers or dates.
const RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMBER_LIKE = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$|^0x[0-9a-f]+$|^0o[0-7]+$|^[-+]?\.(?:inf|nan)$/i;
const DATE_LIKE = /^\d{4}-\d\d?-\d\d?/;

function needsQuotes(text, inList) {
  return text === ''
    || text !== text.trim()
    || /^[-?:,[\]{}#&*!|>'"%@`]/.test(text)
    || /: |:$| #/.test(text)
    || RESERVED.test(text)
    || NUMBER_LIKE.test(text)
    || DATE_LIKE.test(text)
    || (inList && /[,[\]{}]/.test(text));
}

// A JSON string is also a valid YAML double-quoted string.
const scalar = (text, inList = false) => (needsQuotes(text, inList) ? JSON.stringify(text) : text);

const list = (items) => `[${items.map((item) => scalar(item, true)).join(', ')}]`;

// Folded block (">"): single line breaks become spaces, blank lines start a new paragraph.
function folded(text) {
  const lines = text.split('\n').map((line) => line.trim());
  return `>\n${lines.map((line) => (line ? `  ${line}` : '')).join('\n')}`;
}

// ── Reading the form ───────────────────────────────────────────────────

const form = document.getElementById('listing-form');
const output = document.getElementById('yaml-output');
const previewName = document.getElementById('preview-filename');
const status = document.getElementById('form-status');
const field = (name) => form.elements.namedItem(name);

// One line of text: control characters and runs of whitespace become single spaces.
const oneLine = (value) => value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
// Multi-line text: normalized line breaks, other control characters removed.
const multiLine = (value) => value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readForm() {
  const value = (name) => oneLine(field(name).value);
  const types = [...form.querySelectorAll('input[name="type"]:checked')].map((box) => box.value);

  const amount = value('time_amount');
  const unit = field('time_unit').value;
  const time = amount ? `${amount} ${amount === '1' ? unit.replace(/s$/, '') : unit}` : '';

  const resources = value('recommended_resource_allocation').replace(/\s+/g, '').toUpperCase();

  return {
    title: value('title'),
    author: unique(multiLine(field('author').value).split('\n').map(oneLine).filter(Boolean)),
    github: value('github'),
    author_institution: value('author_institution'),
    'maintainer contact': value('maintainer_contact'),
    thumbnail: value('thumbnail'),
    summary: multiLine(field('summary').value),
    description: multiLine(field('description').value),
    nbgitpuller: value('nbgitpuller'),
    tags: unique(value('tags').split(',').map((tag) => tag.trim()).filter(Boolean)),
    type: types,
    difficulty: form.querySelector('input[name="difficulty"]:checked')?.value ?? '',
    time_commitment: time,
    image_tag: types.includes('image') ? value('image_tag') : '',
    recommended_resource_allocation: resources,
    citation: value('citation'),
    last_updated: field('last_updated').value,
  };
}

const FOLDED_KEYS = new Set(['summary', 'description']);

function toYaml(data) {
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${key}: ${list(value)}`);
    } else if (value) {
      if (FOLDED_KEYS.has(key)) lines.push(`${key}: ${folded(value)}`);
      // The date input always gives YYYY-MM-DD; leave it unquoted like the existing listings.
      else if (key === 'last_updated') lines.push(`${key}: ${value}`);
      else lines.push(`${key}: ${scalar(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const fileName = () => `${oneLine(field('filename').value) || 'listing'}.yml`;

function render() {
  output.textContent = toYaml(readForm());
  previewName.textContent = fileName();
}

// ── Defaults and helpers ───────────────────────────────────────────────

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function setDefaults() {
  field('last_updated').value = today();
  field('last_updated').max = today();
}

// Suggest a file name from the title until the person types their own.
let fileNameEdited = false;
const slug = (text) => text
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 60)
  .replace(/_+$/, '');

field('title').addEventListener('input', () => {
  if (!fileNameEdited) field('filename').value = slug(field('title').value);
});
field('filename').addEventListener('input', () => {
  fileNameEdited = field('filename').value !== '';
});

// "Type" needs at least one box checked. The error is reported on the first box.
const typeBoxes = [...form.querySelectorAll('input[name="type"]')];
function checkTypes() {
  const anyChecked = typeBoxes.some((box) => box.checked);
  typeBoxes[0].setCustomValidity(anyChecked ? '' : 'Select at least one type.');
}

// ── Keep aria-invalid in sync with :user-invalid ───────────────────────
// From the modern-web-guidance "user-pseudos" feature notes.

const linkError = (el, shown) => {
  const errorId = el.dataset.error;
  if (!errorId) return;
  const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorId);
  if (shown) ids.push(errorId);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
};

const announcer = document.createElement('div');
announcer.setAttribute('aria-live', 'polite');
announcer.classList.add('visually-hidden');
document.body.append(announcer);
let announceTimer;
let announcedField;

const spokenText = (node) => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  copy.querySelectorAll('[role="img"][aria-label]').forEach((n) => n.replaceWith(`${n.getAttribute('aria-label')}: `));
  return copy.textContent.replace(/\s+/g, ' ').trim();
};
const announceError = (el) => {
  const error = document.getElementById(el.dataset.error);
  if (!error) return;
  const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
  clearTimeout(announceTimer);
  announcer.textContent = '';
  announcedField = el;
  announceTimer = setTimeout(() => { announcer.textContent = label + spokenText(error); }, 500);
};

const flagged = new WeakSet();
const announced = new WeakSet();
const syncAria = (el, announce = false) => {
  if (!el.matches?.('input, select, textarea')) return;
  const invalid = el.matches(':user-invalid');
  if (invalid) {
    if (announce && !announced.has(el)) {
      announceError(el);
      announced.add(el);
    }
    el.setAttribute('aria-invalid', 'true');
    linkError(el, true);
    flagged.add(el);
  } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
    el.setAttribute('aria-invalid', 'false');
    linkError(el, false);
    flagged.delete(el);
    announced.delete(el);
    if (announcedField === el) {
      clearTimeout(announceTimer);
      announcer.textContent = '';
    }
  }
};

document.addEventListener('blur', (e) => syncAria(e.target, true), true);
document.addEventListener('input', (e) => {
  if (e.target.hasAttribute('aria-invalid')) syncAria(e.target);
});
document.addEventListener('change', (e) => {
  syncAria(e.target, true);
  // Checking any type box can fix the error shown on the first one.
  if (typeBoxes.includes(e.target)) syncAria(typeBoxes[0]);
}, true);
document.addEventListener('invalid', (e) => {
  announced.add(e.target);
  syncAria(e.target);
}, true);
document.addEventListener('reset', (e) => {
  setTimeout(() => [...e.target.elements].forEach((el) => syncAria(el)));
}, true);

// ── Link checks ────────────────────────────────────────────────────────
// Warnings only: they never stop someone opening the pull request. The pull
// request check (scripts/check_listings.py) runs the same checks, and more.

class CheckFailed extends Error {}

const enc = encodeURIComponent;
const encodePath = (path) => path.split('/').map(enc).join('/');

// github.com/<owner>/<repo>, optionally followed by /tree/<branch>/<folder> or /blob/<branch>/<file>.
const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+)(\/[^?#]*)?)?\/?(?:[?#].*)?$/i;

function parseGitHub(url) {
  const match = GITHUB_URL.exec(url);
  if (!match) return null;
  return { owner: match[1], repo: match[2], ref: match[3] ?? '', path: (match[4] ?? '').replace(/^\/+|\/+$/g, '') };
}

async function githubApi(path, signal) {
  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, { signal, headers: { Accept: 'application/vnd.github+json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new CheckFailed("Couldn't reach GitHub to check this link. It will be checked when you open the pull request.");
  }
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) {
    throw new CheckFailed('GitHub limits how many links this page can check, and the limit has been reached. The link will be checked when you open the pull request.');
  }
  if (!response.ok) throw new CheckFailed(`GitHub returned an error (${response.status}) while checking this link.`);
  return response.json();
}

const getRepo = (owner, repo, signal) => githubApi(`/repos/${enc(owner)}/${enc(repo)}`, signal);

async function pathExists({ owner, repo, ref, path }, signal) {
  const query = ref ? `?ref=${enc(ref)}` : '';
  return (await githubApi(`/repos/${enc(owner)}/${enc(repo)}/contents/${encodePath(path)}${query}`, signal)) !== null;
}

const notFoundRepo = (owner, repo) => `GitHub couldn't find the repository ${owner}/${repo}. Check the URL, and that the repository is public.`;

async function checkRepository(value, signal) {
  const gh = parseGitHub(value);
  if (!gh) return ['', '']; // GitLab and other hosts are checked in the pull request
  const info = await getRepo(gh.owner, gh.repo, signal);
  if (!info) return ['warn', notFoundRepo(gh.owner, gh.repo)];
  if (gh.path && !(await pathExists(gh, signal))) {
    return ['warn', `${gh.path} isn't on the ${gh.ref} branch of ${info.full_name}. Check the URL.`];
  }
  return ['ok', `Found ${info.full_name}${gh.path ? `/${gh.path}` : ''} on GitHub.`];
}

// The file or folder an nbgitpuller urlpath opens, relative to the repository.
// urlpath is "lab/tree/<clone folder>/<path>" (or tree/, render/, notebooks/, edit/).
function notebookPath(urlpath) {
  const parts = urlpath.split(/[?#]/)[0].split('/').filter(Boolean);
  const index = parts.findIndex((part) => ['tree', 'render', 'notebooks', 'edit'].includes(part));
  if (index === -1) return '';
  return parts.slice(index + 2).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  }).join('/');
}

async function checkNotebook(value, signal) {
  const url = new URL(value);
  if (url.hostname !== 'geolab.earthscope.cloud') {
    return ['warn', "This link doesn't open GeoLab. It should start with https://geolab.earthscope.cloud/."];
  }
  const repoUrl = url.searchParams.get('repo');
  if (!repoUrl) return ['', '']; // a launch permalink, with no repository to check
  const gh = parseGitHub(repoUrl);
  if (!gh) return ['', ''];
  const branch = url.searchParams.get('branch') ?? '';
  const path = notebookPath(url.searchParams.get('urlpath') ?? '');

  const info = await getRepo(gh.owner, gh.repo, signal);
  if (!info) return ['warn', `${notFoundRepo(gh.owner, gh.repo)} It comes from the repo= part of the link.`];
  if (path) {
    if (!(await pathExists({ owner: gh.owner, repo: gh.repo, ref: branch, path }, signal))) {
      const where = branch ? `the ${branch} branch` : 'the default branch';
      return ['warn', `${path} isn't on ${where} of ${info.full_name}. Check the urlpath= and branch= parts of the link.`];
    }
  } else if (branch && !(await githubApi(`/repos/${enc(gh.owner)}/${enc(gh.repo)}/branches/${enc(branch)}`, signal))) {
    return ['warn', `${info.full_name} has no branch called ${branch}. Check the branch= part of the link.`];
  }
  return ['ok', `Found ${path || 'the repository'} in ${info.full_name}${branch ? ` (${branch} branch)` : ''}.`];
}

// Same rule as library_listing.py: a relative thumbnail path is read from the
// repository's default branch, and only when the repository URL is the repo's main page.
const LISTING_REPO = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/;

function resolveThumbnail(thumbnail, github) {
  if (/^https?:\/\//.test(thumbnail)) return thumbnail;
  const match = LISTING_REPO.exec(github);
  return match ? `https://raw.githubusercontent.com/${match[1]}/HEAD/${thumbnail.replace(/^\/+/, '')}` : null;
}

function loadImage(src, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    signal.addEventListener('abort', () => {
      img.src = '';
      reject(new DOMException('Aborted', 'AbortError'));
    });
    img.src = src;
  });
}

const preview = document.getElementById('thumbnail-preview');

async function checkThumbnail(value, signal) {
  const github = field('github').value.trim();
  const src = resolveThumbnail(value, github);
  if (!src) {
    return ['warn', github
      ? "The library can only find an image by its path when the repository URL is the repository's main page, like https://github.com/your-org/your-repo. Use the image's full URL instead."
      : "Enter the repository URL so the library can find this image, or use the image's full URL."];
  }
  if (/^https?:\/\/(?:www\.)?github\.com\/[^?#]+\/blob\//i.test(src) && !/[?&]raw=true\b/.test(src)) {
    return ['warn', "This links to GitHub's page about the image, not the image itself. Add ?raw=true to the end of the URL."];
  }
  if (!(await loadImage(src, signal))) {
    return ['warn', "The image couldn't be loaded. Check the URL or path, and that the file is public."];
  }
  preview.src = src;
  preview.hidden = false;
  return ['ok', 'Image found. This is how it will be cropped on the project card.'];
}

const LINK_CHECKS = { github: checkRepository, nbgitpuller: checkNotebook, thumbnail: checkThumbnail };
const running = new Map();

// Add or remove one id in a field's aria-describedby.
function describe(el, id, on) {
  const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== id);
  if (on) ids.push(id);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
}

function showCheck(input, state, message) {
  const box = document.getElementById(`${input.id}-check`);
  box.dataset.state = state;
  box.replaceChildren();
  if (message) {
    const icon = document.createElement('span');
    if (state === 'warn') {
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', 'Warning');
      icon.textContent = '⚠';
    } else if (state === 'ok') {
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '✓';
    }
    box.append(...(icon.textContent ? [icon, ' '] : []), message);
  }
  if (input.id === 'thumbnail' && state !== 'ok') {
    preview.hidden = true;
    preview.removeAttribute('src');
  }
  // Read the warning with the field, and announce it once through the page's live region.
  describe(input, box.id, state === 'warn');
  if (state === 'warn') {
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announceTimer = setTimeout(() => {
      announcer.textContent = `${spokenText(input.labels[0])}: ${spokenText(box)}`;
    }, 500);
  }
}

function clearCheck(input) {
  running.get(input.id)?.abort();
  running.delete(input.id);
  showCheck(input, '', '');
}

async function runCheck(input) {
  running.get(input.id)?.abort();
  const value = input.value.trim();
  if (!value || !input.validity.valid) {
    clearCheck(input);
    return;
  }
  const controller = new AbortController();
  running.set(input.id, controller);
  showCheck(input, 'checking', 'Checking the link…');
  try {
    const [state, message] = await LINK_CHECKS[input.id](value, controller.signal);
    if (!controller.signal.aborted) showCheck(input, state, message);
  } catch (err) {
    if (controller.signal.aborted || err.name === 'AbortError') return;
    showCheck(input, 'skip', err instanceof CheckFailed ? err.message : "Couldn't check this link.");
  }
}

// ── Form events ────────────────────────────────────────────────────────

form.addEventListener('input', (event) => {
  status.textContent = '';
  // A result for the old value would be misleading while the link is being edited.
  if (event.target.id in LINK_CHECKS) clearCheck(event.target);
  render();
});
form.addEventListener('change', (event) => {
  checkTypes();
  render();
  // 'change' fires when the person leaves a field they've edited.
  const { id } = event.target;
  if (id in LINK_CHECKS) runCheck(event.target);
  // A relative thumbnail path depends on the repository URL.
  if (id === 'github' && field('thumbnail').value.trim()) runCheck(field('thumbnail'));
});

form.addEventListener('reset', () => {
  // Reset fires before the fields are cleared, so restore the defaults afterwards.
  setTimeout(() => {
    fileNameEdited = false;
    setDefaults();
    checkTypes();
    Object.keys(LINK_CHECKS).forEach((id) => clearCheck(field(id)));
    status.textContent = '';
    render();
  });
});

// GitHub's "new file" page, with the file name and contents filled in. Signing in,
// committing and creating the pull request happen there; GitHub forks the
// repository for people who can't push to it.
function githubNewFileUrl(name, yaml) {
  const params = new URLSearchParams({ filename: name });
  if (yaml !== undefined) params.set('value', yaml);
  return `https://github.com/${REPO}/new/${BRANCH}/${PROJECTS_DIR}?${params}`;
}

// Native validation runs before 'submit', so this only runs when every field is valid.
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const yaml = toYaml(readForm());
  const name = fileName();
  const url = githubNewFileUrl(name, yaml);

  if (url.length <= MAX_GITHUB_URL) {
    window.open(url, '_blank', 'noopener');
    status.textContent = `Opened GitHub in a new tab with ${name}. Choose Commit changes, then Create pull request.`;
    return;
  }

  // Too long for a link: open the page with just the file name, and copy the
  // contents for pasting. Both start here, while the click still counts.
  const copied = navigator.clipboard?.writeText(yaml) ?? Promise.reject();
  window.open(githubNewFileUrl(name), '_blank', 'noopener');
  copied.then(
    () => { status.textContent = `Your listing is too long to fill in on GitHub, so it's been copied. Paste it into ${name} in the new tab, then choose Commit changes and Create pull request.`; },
    () => { status.textContent = `Your listing is too long to fill in on GitHub. Copy it with the button above the preview and paste it into ${name} in the new tab, then choose Commit changes and Create pull request.`; },
  );
});

// ── Copy button ────────────────────────────────────────────────────────
// From the modern-web-guidance "copy-button" guide.

const timers = new WeakMap();
let lastMessage = '';

function report(button, ok) {
  const tip = button.nextElementSibling;
  clearTimeout(timers.get(button));
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');
  let message = ok ? 'Copied' : 'Copy failed';
  if (message === lastMessage) message += ' '; // VoiceOver skips repeated messages
  lastMessage = message;
  tip.textContent = '';
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  requestAnimationFrame(() => { tip.textContent = message; });
  timers.set(button, setTimeout(() => {
    button.removeAttribute('data-copied');
    button.removeAttribute('data-failed');
    tip.textContent = '';
  }, 2000));
}

async function copy(button, target) {
  const text = target.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    report(button, true);
  } catch {
    report(button, false);
  }
}

if ('CommandEvent' in window) {
  document.addEventListener('command', (event) => {
    if (event.command === '--copy') copy(event.source, event.target);
  }, true);
} else {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[command="--copy"]');
    if (!button) return;
    const target = document.getElementById(button.getAttribute('commandfor'));
    if (target) copy(button, target);
  });
}

// ── Start ──────────────────────────────────────────────────────────────

setDefaults();
checkTypes();
document.querySelectorAll('input, select, textarea').forEach((el) => syncAria(el));
render();
