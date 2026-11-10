// GeoLab Library listing form: builds a project listing YAML file from the form.
// Field order and keys follow template.yml in the geolab-library repository.

const REPO = 'EarthScope/geolab-library';
const BRANCH = 'main';
const PROJECTS_DIR = 'projects';
// GitHub rejects very long URLs; past this, ask people to download the file instead.
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

// ── Form events ────────────────────────────────────────────────────────

form.addEventListener('input', () => {
  status.textContent = '';
  render();
});
form.addEventListener('change', () => {
  checkTypes();
  render();
});

form.addEventListener('reset', () => {
  // Reset fires before the fields are cleared, so restore the defaults afterwards.
  setTimeout(() => {
    fileNameEdited = false;
    setDefaults();
    checkTypes();
    status.textContent = '';
    render();
  });
});

function download(yaml, name) {
  const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function githubNewFileUrl(yaml, name) {
  const params = new URLSearchParams({ filename: name, value: yaml });
  return `https://github.com/${REPO}/new/${BRANCH}/${PROJECTS_DIR}?${params}`;
}

// Native validation runs before 'submit', so this only runs when every field is valid.
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const yaml = toYaml(readForm());
  const name = fileName();

  if (event.submitter?.value === 'github') {
    const url = githubNewFileUrl(yaml, name);
    if (url.length > MAX_GITHUB_URL) {
      status.textContent = `Your listing is too long to send to GitHub in a link. Download ${name} instead and upload it to the ${PROJECTS_DIR}/ folder.`;
      return;
    }
    window.open(url, '_blank', 'noopener');
    status.textContent = `Opened GitHub in a new tab with ${name}. Follow the steps there to open a pull request.`;
    return;
  }

  download(yaml, name);
  status.textContent = `Downloaded ${name}. Add it to the ${PROJECTS_DIR}/ folder of ${REPO} in a pull request.`;
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
